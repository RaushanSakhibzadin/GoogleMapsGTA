--!strict
-- THE DRIVING MODEL, ported from js/entities.js drive().
--
-- This is the one piece of the browser game worth carrying over line for line
-- rather than redesigning. Every constant in here was arrived at by driving the
-- thing and changing it, and the comments in the original say what each one is
-- for; the numbers are reproduced exactly and the reasoning is summarised where
-- it explains why a line looks odd.
--
-- IT WORKS IN METRES AND SECONDS, not in studs. TOP_SPEED is 100 m/s, accel is
-- 40 m/s^2, the off-road crawl is 4.5 m/s. Converting those to studs would mean
-- re-deriving every one of them and losing the only thing that makes a port
-- better than a rewrite. The caller multiplies by studsPerMetre when it places
-- the part, and nothing in this file knows that studs exist.
--
-- COORDINATES match the browser's world: +x east, +y SOUTH (the projection in
-- geo.js negates latitude). The caller maps y to Roblox Z.
--
-- IT IS PURE. Given a state table, an input table and dt it mutates the state
-- and returns the forward/lateral split. No instances, no services, no yields —
-- so the server can run it to validate a client, and an NPC can run it, from the
-- same code. That is exactly how drive() is shared by the player, the traffic
-- and the police in the original.
--
-- WHAT IS DELIBERATELY NOT HERE YET: the terrain grade (there are no hills in
-- the bake), the committed 180 (`c.spin`), tyre marks, smoke, the airborne and
-- flipped cases from body3d.js. Each is a self-contained block in the original
-- and can come across when there is something to hang it on.

local VehicleModel = {}

-- ---------------------------------------------------------------- helpers

-- Frame-rate independent decay, straight from js/util.js:25. Every smoothing
-- term below goes through it, which is why they can be quoted as rates rather
-- than as per-frame fractions.
local function decay(k: number, dt: number): number
	return 1 - math.exp(-k * dt)
end

local function clamp(v: number, a: number, b: number): number
	if v < a then
		return a
	elseif v > b then
		return b
	end
	return v
end

local function lerp(a: number, b: number, t: number): number
	return a + (b - a) * t
end

-- ---------------------------------------------------------------- constants

VehicleModel.TOP_SPEED = 100 -- m/s, 360 km/h (geo.js:47)
VehicleModel.STRAY_TOP = 4.5 -- m/s off the tarmac, about 16 km/h
VehicleModel.STRAY_DRAG = 9.5
VehicleModel.STRAY_TOL = 10 -- metres of slack before the crawl applies

-- The mask is 8 m cells stamped along centrelines and the roads are DRAWN from
-- their own widths; the two do not agree to the metre. STRAY_TOL is a bit over
-- one cell for exactly that reason -- a false negative here costs nothing and a
-- false positive is a car stopped dead on tarmac.

export type Car = {
	x: number,
	y: number,
	h: number, -- heading, radians, 0 = east
	vx: number,
	vy: number,
	steer: number, -- the rack's current angle, lagged behind the input
	gasT: number, -- throttle, lagged
	brakeT: number, -- brake, lagged
	road: boolean,
	maxSpeed: number,
	accel: number,
	turn: number,
	w: number,
	l: number,
	kind: string,
	-- A VEHICLE THAT IS ALLOWED OFF THE TARMAC, which is the fire appliance and
	-- the ambulance. A fire is a building and the last thirty metres to one are
	-- a forecourt or a yard, so without this the end of every call is a crawl at
	-- walking pace -- reported from play in the browser twice, once at a
	-- hospital and once at a fire, and fixed there with the same flag.
	-- Optional so every other car in the game stays exactly as it was.
	offroad: boolean?,
}

export type Input = {
	gas: number,
	brake: number,
	steer: number,
	hand: number,
}

-- makeCar's player branch, js/entities.js:43. The accel of 40 is load-bearing
-- and the original explains why: constant force against linear drag settles at
-- accel/0.32, so at 28 the car tops out at 87 m/s and the 100 ceiling is a lie.
-- At 40 the CLAMP is what limits top speed, which is what a top speed should be.
function VehicleModel.newCar(x: number, y: number, h: number): Car
	return {
		x = x,
		y = y,
		h = h,
		vx = 0,
		vy = 0,
		steer = 0,
		gasT = 0,
		brakeT = 0,
		road = true,
		maxSpeed = VehicleModel.TOP_SPEED,
		accel = 40,
		turn = 2.7,
		w = 2.0,
		l = 4.5,
		kind = "player",
	}
end

-- ---------------------------------------------------------------- the step

-- `onTarmac` is a function (x, y) -> boolean, or nil for "everywhere is road".
-- `revReal` gives reversing its real-car steering; see the note further down.
function VehicleModel.step(
	c: Car,
	inp: Input,
	dt: number,
	onTarmac: ((number, number) -> boolean)?,
	revReal: boolean?
): (number, number)
	local throttle = inp.gas > 0
	local brake = inp.brake > 0
	local hand = inp.hand > 0
	local steerIn = inp.steer

	local cs, sn = math.cos(c.h), math.sin(c.h)

	-- decompose velocity into forward / lateral against the car's heading
	local vf = c.vx * cs + c.vy * sn
	local vl = -c.vx * sn + c.vy * cs

	-- THE ROAD IS THE GAME. Off the tarmac the car drops to walking pace. In the
	-- browser this is gated on roadDataHere() as well, because ground that has
	-- not streamed in yet must stay fast -- the bake has no streaming frontier,
	-- so that guard has nothing to protect against here and is left out.
	local stray = false
	if onTarmac then
		c.road = onTarmac(c.x, c.y)
		-- The appliance still KNOWS it is off the road -- c.road stays false, so
		-- it still loses grip and still drags like a vehicle on a forecourt. What
		-- it does not get is STRAY_TOP, the walking pace that exists to stop
		-- ordinary cars driving across the city in a straight line.
		stray = not c.road and not c.offroad
	else
		c.road = true
	end

	local grip = if c.road then 1 else 0.58
	local top = if stray then VehicleModel.STRAY_TOP else c.maxSpeed * grip

	-- INERTIA. Nothing in a car happens the instant you ask for it. These are
	-- first-order lags, so they cost one number each and the car still reaches
	-- exactly the same top speed. Without them the torque appeared and vanished
	-- on the same frame as the button, which is what made the car feel like it
	-- was being dragged around rather than driven.
	c.gasT += ((if throttle then 1 else 0) - c.gasT) * decay(if throttle then 5.5 else 8, dt)
	c.brakeT += ((if brake then 1 else 0) - c.brakeT) * decay(if brake then 11 else 14, dt)

	if c.gasT > 0.002 then
		vf += c.accel * dt * c.gasT * (if vf < 0 then 2.2 else 1)
	end
	if c.brakeT > 0.002 then
		vf -= (if vf > 0.8 then c.accel * 1.9 else c.accel * 0.55) * dt * c.brakeT
	end
	if not throttle and not brake then
		vf -= vf * decay(0.9, dt) -- engine braking
	end

	vf -= vf * decay(if c.road then 0.32 else (if stray then VehicleModel.STRAY_DRAG else 1.5), dt)
	if hand then
		vf -= vf * decay(0.5, dt) -- a locked rear axle scrubs speed
	end

	vf = clamp(vf, -top * 0.45, top)

	-- Lateral grip: the handbrake lets the back end go, which is half of a drift.
	-- This single number is the whole drift model.
	local lat = if hand then 1.7 else (if c.road then 9.5 else 6.5)
	vl -= vl * decay(lat, dt)

	local spd = math.abs(vf)
	local rolling = clamp(spd / 4.5, 0, 1) -- nothing pivots from a standstill

	-- Steering fades with speed, down to a third of its authority. Held, it stops
	-- fading -- the rear is unloaded so the nose still bites -- but it is NOT
	-- boosted beyond that: what the handbrake buys you is the slide, not a faster
	-- spin.
	local auth = if hand then 0.92 else lerp(1, 0.34, clamp(spd / 30, 0, 1))

	-- The wheels take a moment to come round, and a moment to straighten. This is
	-- what makes a car feel like it has a nose. Faster to straighten than to
	-- turn, the way a real rack self-centres.
	c.steer += (steerIn - c.steer)
		* decay(if math.abs(steerIn) > math.abs(c.steer) then 7 else 11, dt)
	local yaw = c.steer * c.turn * auth * rolling

	-- REVERSING, AND WHOSE IDEA OF IT.
	--
	-- A real car reversing rotates the other way -- heading rate is (v/L)tan d
	-- and v is negative, so turning left swings the nose right. That is correct,
	-- and it is also the single most complained-about thing in every driving game
	-- that does it, because a thumb on a stick is not a pair of hands on a wheel.
	-- So the stick is taken literally by default and revReal puts the real
	-- physics back for anyone who wants it.
	--
	-- A DRIFT IS STILL NOT REVERSING: vf goes negative as the heading swings past
	-- 90 degrees in a slide, and inverting there made the car fight its own spin
	-- exactly halfway through it. Hence the `not hand`.
	local backwards = (not hand) and vf < -0.5
	local flipSteer = backwards and revReal == true
	c.h += yaw * dt * (if flipSteer then -1 else 1)

	local cs2, sn2 = math.cos(c.h), math.sin(c.h)
	c.vx = cs2 * vf - sn2 * vl
	c.vy = sn2 * vf + cs2 * vl

	c.x += c.vx * dt
	c.y += c.vy * dt

	return vf, vl
end

-- ---------------------------------------------------------------- the camera

-- THE CAMERA FACES THE WAY YOU ARE GOING, from js/game.js:932.
--
-- Two thresholds with a dead band between them, and the dead band is half the
-- feature: one threshold chatters, so shunting back and forth out of a parking
-- space would whip the camera round several times a second. It reads the speed
-- ALONG THE HEADING, so a car sliding sideways in a drift does not flip it.
VehicleModel.BACKVIEW_ON = 2.5
VehicleModel.BACKVIEW_OFF = 0.8

function VehicleModel.backView(c: Car, wasBack: boolean): boolean
	local vf = c.vx * math.cos(c.h) + c.vy * math.sin(c.h)
	if vf < -VehicleModel.BACKVIEW_ON then
		return true
	elseif vf > -VehicleModel.BACKVIEW_OFF then
		return false
	end
	return wasBack
end

function VehicleModel.viewHeading(c: Car, wasBack: boolean): (number, boolean)
	local back = VehicleModel.backView(c, wasBack)
	return c.h + (if back then math.pi else 0), back
end

-- Shortest signed angle from a to b, for lerping a heading without going the
-- long way round at the +/-pi seam.
function VehicleModel.angDiff(a: number, b: number): number
	local d = (b - a) % (2 * math.pi)
	if d > math.pi then
		d -= 2 * math.pi
	end
	return d
end

VehicleModel.decay = decay
VehicleModel.clamp = clamp
VehicleModel.lerp = lerp

return VehicleModel
