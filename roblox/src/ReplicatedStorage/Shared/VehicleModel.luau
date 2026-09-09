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
-- the bake), the airborne and flipped cases from body3d.js. Each is a
-- self-contained block in the original and can come across when there is
-- something to hang it on.
--
-- THE COMMITTED 180 AND TYRE MARKS ARE HERE, though, ported from
-- js/entities.js:730-740,766-788. The spin is data the caller has to hang a
-- press-edge on (see Input.spinPress); marking is a boolean this returns
-- rather than a list this keeps, because this file is instance-free by
-- design (line 19 above) and laying an actual mark is the caller's job, same
-- as building the car is CarBuild's.

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

-- How long a committed 180 takes at a full half-turn, eased in and out;
-- shorter turns scale down from this (entities.js:106, game.js:2251-2257).
local SPIN_SECS = 0.85
-- The old threshold wanted 5.5 m/s of lateral slip to lay a mark -- more than
-- the old handbrake could produce, so a drift laid no rubber at all. The
-- player's own car marks at 2.6; everyone else keeps the old, higher number,
-- because a five-star scrum laying rubber from thirty cars at once is a lot
-- of decals for a slide only one of them is actually doing (entities.js:775).
local SLIP_MARK_PLAYER = 2.6
local SLIP_MARK_OTHER = 5.5

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
	-- THE COMMITTED 180, mid-turn. nil the rest of the time -- "is c.spin set"
	-- IS "is a spin in progress", the same truthy/falsy test entities.js reads.
	spin: {
		t: number, -- seconds into the turn
		secs: number, -- total duration, scaled to how far it has to turn
		from: number, -- heading when it was armed
		rad: number, -- how far it turns, radians, always positive
		dir: number, -- signed: which way, and by how much of `rad` (see step())
	}?,
	-- Remembered so a second press with the stick centred repeats the last
	-- direction instead of defaulting to the same way every time.
	lastSpinDir: number?,
}

export type Input = {
	gas: number,
	brake: number,
	steer: number,
	hand: number,
	-- True on the single frame the handbrake goes from up to down. Edge
	-- detection lives with whoever reads the keys (VehicleController), not
	-- here, so this file stays a pure function of "what is true this frame"
	-- rather than needing to remember last frame's input itself.
	spinPress: boolean?,
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
): (number, number, boolean)
	local throttle = inp.gas > 0
	local brake = inp.brake > 0
	local hand = inp.hand > 0
	local steerIn = inp.steer

	-- ARMED ON THE PRESS, not while held -- leaning on the button would spin
	-- you like a top otherwise. One press, one turn; press again for another.
	-- game.js:2246-2260.
	if inp.spinPress and not c.spin then
		local speed = math.sqrt(c.vx * c.vx + c.vy * c.vy)
		-- THE TURN IS HALF THE SPEED: 100 m/s (360 km/h, top speed) buys a half
		-- turn: speed(km/h) * .5, clamped to a full circle.
		local deg = clamp(speed * 3.6 * 0.5, 0, 360)
		-- dir is the RAW steer value, not just its sign -- a gentle steer while
		-- pulling the handbrake commits to a proportionally smaller turn, not a
		-- full one. Falls back to the last spin's direction, then to +1, the
		-- same `inp.steer || c.lastSpinDir || 1` the browser reads.
		local dir = if steerIn ~= 0 then steerIn else (c.lastSpinDir or 1)
		c.spin = {
			t = 0,
			from = c.h,
			rad = math.rad(deg),
			-- Longer turns take longer, at a floor so even a walking-pace flick
			-- is a movement you can see rather than a snap.
			secs = clamp(SPIN_SECS * deg / 180, 0.28, 1.7),
			dir = dir,
		}
		c.lastSpinDir = dir
	end

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
	-- This single number is the whole drift model. Mid-spin it drops further
	-- still -- a committed 180 is the back end fully gone, not half.
	local lat = if c.spin then 0.3 elseif hand then 1.7 else (if c.road then 9.5 else 6.5)
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

	-- THE TURN. Once armed, the heading is driven straight to its target angle
	-- on a smoothstep -- eased in, whips through the middle, eased out -- which
	-- overrides whatever the ordinary steering integration above just did.
	-- Driving the angle directly is what lands it on the number exactly every
	-- time, instead of depending on how long the button happened to be held.
	-- entities.js:735-740.
	local marking = false
	if c.spin then
		local spin = c.spin
		spin.t += dt
		local u = clamp(spin.t / spin.secs, 0, 1)
		local eased = u * u * (3 - 2 * u)
		c.h = spin.from + spin.dir * spin.rad * eased
		if u >= 1 then
			c.spin = nil
		end
		marking = true
	end

	local cs2, sn2 = math.cos(c.h), math.sin(c.h)
	c.vx = cs2 * vf - sn2 * vl
	c.vy = sn2 * vf + cs2 * vl

	c.x += c.vx * dt
	c.y += c.vy * dt

	-- TYRE MARKS. A committed 180 marks for its whole arc regardless -- that
	-- arc IS the manoeuvre and it should be there on the road afterwards --
	-- otherwise held handbrake (the player only) or enough lateral slip that
	-- the tail is genuinely stepping out. entities.js:766-778.
	if not marking and spd > 3 then
		local slipMark = if c.kind == "player" then SLIP_MARK_PLAYER else SLIP_MARK_OTHER
		marking = (hand and c.kind == "player") or math.abs(vl) > slipMark
	end

	return vf, vl, marking
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
