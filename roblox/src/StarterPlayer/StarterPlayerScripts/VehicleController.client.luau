--!strict
-- Drive the car: input, the model, the camera, and what the server is told.
--
-- THE LOOP IS THE BROWSER'S LOOP (js/main.js:10): an accumulator and a fixed
-- 1/60 step, capped at five catch-up steps a frame. That cap is why the original
-- runs slower than the wall clock below 12 fps, and it is the right trade for
-- the same reason here -- a physics step that can spiral on a slow frame is
-- worse than one that briefly runs slow.
--
-- THE CAR IS KINEMATIC. The model integrates position itself, exactly as the
-- browser does, and this script writes that position onto an anchored model.
-- Roblox's own physics is not involved and must not be: the driving feel in
-- VehicleModel comes from constants tuned against that integrator, and handing
-- the car to constraints and a real suspension would mean re-deriving all of
-- them and getting a different game.
--
-- Buildings stop it: after each step the car is resolved against the collision
-- volumes by Shared/BuildingCollide, which is the browser's buildingCollide()
-- with the same eight body points and the same wedge fallback.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local UserInputService = game:GetService("UserInputService")

local player = Players.LocalPlayer
local camera = workspace.CurrentCamera

local Shared = ReplicatedStorage:WaitForChild("Shared")
local VehicleModel = require(Shared:WaitForChild("VehicleModel"))
local CarBuild = require(Shared:WaitForChild("CarBuild"))
local Tarmac = require(Shared:WaitForChild("Tarmac"))
local BuildingCollide = require(Shared:WaitForChild("BuildingCollide"))
local PlayerCar = require(Shared:WaitForChild("PlayerCar"))
local Audio = require(Shared:WaitForChild("Audio"))
local Meta = require(ReplicatedStorage:WaitForChild("CityVisual"):WaitForChild("CityMeta"))

local Remotes = ReplicatedStorage:WaitForChild("Remotes")
local CarState = Remotes:WaitForChild("CarState") :: RemoteEvent
local CarCorrection = Remotes:WaitForChild("CarCorrection") :: RemoteEvent

local S = Meta.studsPerMetre

-- ---------------------------------------------------------------- settings

-- Reversing steering. False takes the stick literally -- back-and-left reverses
-- to the left -- which is what was asked for in the browser game and is the
-- default there too. True gives a real car's behaviour.
local REV_REAL = false

local SEND_HZ = 15 -- position reports a second; the server only validates

-- ---------------------------------------------------------------- input

local keys = {}
UserInputService.InputBegan:Connect(function(input, processed)
	if not processed and input.UserInputType == Enum.UserInputType.Keyboard then
		keys[input.KeyCode] = true
	end
end)
UserInputService.InputEnded:Connect(function(input)
	if input.UserInputType == Enum.UserInputType.Keyboard then
		keys[input.KeyCode] = nil
	end
end)

-- Keyboard and gamepad are ADDED, not chosen between, the same way the browser
-- adds its on-screen stick to the keyboard: whichever is actually being held
-- wins, because the other reads zero. Steering takes whichever is further from
-- centre, so a key press is still full lock and the stick's analogue value
-- survives -- an `or` here would round every partial input up to 1.
local function readInput()
	local K = Enum.KeyCode
	local L = keys[K.A] or keys[K.Left]
	local R = keys[K.D] or keys[K.Right]
	local U = keys[K.W] or keys[K.Up]
	local D = keys[K.S] or keys[K.Down]
	local H = keys[K.Space]

	local kSteer = (if R then 1 else 0) - (if L then 1 else 0)

	local pad = 0
	local gasPad, brakePad = false, false
	for _, gp in UserInputService:GetNavigationGamepads() do
		local st = UserInputService:GetGamepadState(gp)
		for _, s in st do
			if s.KeyCode == Enum.KeyCode.Thumbstick1 and math.abs(s.Position.X) > 0.15 then
				pad = s.Position.X
			elseif s.KeyCode == Enum.KeyCode.ButtonR2 and s.Position.Z > 0.1 then
				gasPad = true
			elseif s.KeyCode == Enum.KeyCode.ButtonL2 and s.Position.Z > 0.1 then
				brakePad = true
			end
		end
	end

	local steer = if math.abs(pad) > math.abs(kSteer) then pad else kSteer

	return {
		steer = steer,
		gas = if (U or gasPad) then 1 else 0,
		brake = if (D or brakePad) then 1 else 0,
		hand = if H then 1 else 0,
	}
end

-- ---------------------------------------------------------------- the car

local car = VehicleModel.newCar(0, 0, 0)
local model: Model? = nil
local backView = false

-- PUBLISHED, so the traffic and the pedestrians on this client can see it -- and
-- so the traffic can shunt it. See Shared/PlayerCar for why that is a module
-- table rather than a remote.
PlayerCar.set(car)

local cars = workspace:WaitForChild("Cars")
local function findMine(): Model?
	for _, m in cars:GetChildren() do
		if m:IsA("Model") and m:GetAttribute("Owner") == player.UserId then
			return m
		end
	end
	return nil
end

CarCorrection.OnClientEvent:Connect(function(x, y, h)
	-- The server has rejected where we said we were, or this is the spawn. Take
	-- its word: it is holding the last position it believed, so continuing to
	-- integrate from ours would just get rejected again every frame.
	car.x, car.y, car.h = x, y, h
	car.vx, car.vy = 0, 0
end)

-- ---------------------------------------------------------------- camera

-- The chase camera from js/render3d.js camera3D, reduced to what matters: an
-- eye on a circle behind the car, looking at a point that leads it, with the
-- angle easing towards viewHeading rather than snapping. viewHeading is what
-- swings the camera round the front when you reverse.
local CAM_BACK = 9 -- metres behind
local CAM_UP = 3.4 -- metres above
local CAM_LEAD = 7 -- metres ahead of the car to aim at
local camH = 0

local function updateCamera(dt: number)
	local face, back = VehicleModel.viewHeading(car, backView)
	backView = back

	-- Faster to catch up at low speed, lazier at speed, so a flick of the wheel
	-- on a straight does not throw the whole view about.
	local spd = math.sqrt(car.vx * car.vx + car.vy * car.vy)
	local k = VehicleModel.clamp(spd / 30, 0, 1)
	camH += VehicleModel.angDiff(camH, face) * VehicleModel.decay(VehicleModel.lerp(5.5, 2.6, k), dt)

	local ex = car.x - math.cos(camH) * CAM_BACK
	local ey = car.y - math.sin(camH) * CAM_BACK
	local tx = car.x + math.cos(camH) * CAM_LEAD
	local ty = car.y + math.sin(camH) * CAM_LEAD

	camera.CFrame = CFrame.lookAt(
		Vector3.new(ex * S, CAM_UP * S, ey * S),
		Vector3.new(tx * S, 1.2 * S, ty * S)
	)
end

-- ---------------------------------------------------------------- sound

-- THE ENGINE IS ONE LOW NOTE, PITCHED BY ROAD SPEED, because there is no engine
-- loop in the Roblox client library and no oscillator in Luau -- see
-- Shared/Audio for why nothing here uses an uploaded asset. It reads as an
-- engine because it rises and falls with the throttle, which is the part your
-- ear is actually listening to.
--
-- Every use is still guarded on the sound existing, because a slot name can be
-- wrong and the car has to drive exactly as well either way. What is gone is
-- the gate that could turn a working sound off; see Shared/Audio.
--
-- warm() plays each candidate silently once and prints what actually loaded on
-- this client, which is the only reliable way to find out and the thing the
-- first version got wrong.
Audio.warm()

local engine: Sound? = nil
local scrub: Sound? = nil

local IDLE_PITCH = 0.55
local REV_PITCH = 2.4
local hitCool = 0

-- ONCE, WHEN THE CAR APPEARS. Audio.make never returns nil for a slot that
-- exists any more -- the version that could was the one that gated on an
-- unverifiable probe and turned every sound in the game off -- so there is
-- nothing here to retry.
local function attachSound(m: Model): boolean
	local body = m.PrimaryPart
	if not body then
		return true -- nothing to attach to
	end
	engine = Audio.make("engine", body)
	if engine then
		local e = engine :: Sound
		e.Name = "Engine"
		e.Looped = true
		e.Volume = 0
		e.PlaybackSpeed = IDLE_PITCH
		-- THE ROLLOFF WAS WHY IT WAS QUIET, more than the volume was. A Sound on
		-- a part is 3D, and Roblox attenuates it past RollOffMinDistance --
		-- which defaults to about ten studs. The chase camera sits NINE METRES
		-- behind the car, which at three studs a metre is twenty-seven: your own
		-- engine was being faded out for being too far away from you.
		--
		-- So the near field is made big enough to contain the camera. It is
		-- still 3D, so another player's car still fades with distance; it is
		-- only yours that is always in the front row.
		e.RollOffMinDistance = 90
		e.RollOffMaxDistance = 500
		e:Play()
	end
	scrub = Audio.make("impact", body)
	if scrub then
		local t = scrub :: Sound
		t.Name = "Scrub"
		t.Looped = true
		t.Volume = 0
		t.PlaybackSpeed = 0.45
		t.RollOffMinDistance = 60
		t.RollOffMaxDistance = 300
		t:Play()
	end
	return true
end

-- `lat` is how hard the car is sliding sideways: that, and not speed, is what a
-- tyre actually complains about.
local function updateSound(dt: number, lat: number)
	local spd = math.sqrt(car.vx * car.vx + car.vy * car.vy)
	if engine then
		local e = engine :: Sound
		-- Pitch follows speed with a floor, so a stationary car still idles.
		local want = IDLE_PITCH + (REV_PITCH - IDLE_PITCH) * math.min(spd / VehicleModel.TOP_SPEED, 1) ^ 0.55
		e.PlaybackSpeed += (want - e.PlaybackSpeed) * VehicleModel.decay(9, dt)
		-- And volume follows the THROTTLE more than the speed, so lifting off at
		-- eighty is audible. gasT is the lagged throttle the model already keeps.
		-- Louder across the board, and weighted to the throttle: idling should be
		-- present, and flooring it should be the loudest thing on screen. The
		-- Engine mixer group scales all of it, so this is the shape rather than
		-- the level -- see the settings panel.
		local target = 0.45 + 0.40 * car.gasT + 0.15 * math.min(spd / 40, 1)
		e.Volume += (target - e.Volume) * VehicleModel.decay(6, dt)
	end
	if scrub then
		local t = scrub :: Sound
		local slide = math.min(math.abs(lat) / 9, 1)
		local target = if spd > 4 then slide * 0.35 else 0
		t.Volume += (target - t.Volume) * VehicleModel.decay(10, dt)
	end
end

-- ---------------------------------------------------------------- the loop

local STEP = 1 / 60
local acc = 0
local sendAcc = 0

local onTarmac = function(x: number, y: number): boolean
	return Tarmac.nearRoad(x, y)
end

-- ---------------------------------------------------------------- collision

-- The collision folder is built by the server on boot, so it may not be there
-- for the first frames of a join.
local collisionFolder: Instance? = workspace:FindFirstChild("Collision")
workspace.ChildAdded:Connect(function(child)
	if child.Name == "Collision" then
		collisionFolder = child
	end
end)

local overlap = OverlapParams.new()
overlap.FilterType = Enum.RaycastFilterType.Include
overlap.MaxParts = 64

-- Reused across frames rather than reallocated: this runs sixty times a second
-- and the table is the only garbage the loop would otherwise make.
local nearBoxes: { { x: number, z: number, hx: number, hz: number } } = {}

-- HOW FAR TO LOOK. Half the car's diagonal plus a metre of margin, plus the
-- furthest it can travel in one frame -- anything outside that cannot be
-- touched before the next query.
local LOOK = 14

camera.CameraType = Enum.CameraType.Scriptable

RunService.RenderStepped:Connect(function(dt)
	if not model then
		model = findMine()
		if not model then
			return
		end
		attachSound(model :: Model)

		-- SAID OUT LOUD, ONCE. "The car is invisible" is a symptom with several
		-- possible causes -- streamed out, no parts, parked underground, camera
		-- somewhere else -- and they are indistinguishable from a screenshot.
		-- This costs one line in the log and settles it.
		task.spawn(function()
			task.wait(1)
			local m = model :: Model
			local parts, hidden = 0, 0
			for _, d in m:GetDescendants() do
				if d:IsA("BasePart") then
					parts += 1
					if d.Transparency > 0.95 then
						hidden += 1
					end
				end
			end
			local p = m:GetPivot().Position
			print(
				("[car] %d parts (%d invisible), pivot %.0f,%.0f,%.0f, camera %.0f,%.0f,%.0f, primary=%s")
					:format(
						parts,
						hidden,
						p.X,
						p.Y,
						p.Z,
						camera.CFrame.Position.X,
						camera.CFrame.Position.Y,
						camera.CFrame.Position.Z,
						tostring(m.PrimaryPart ~= nil)
					)
			)
		end)
	end

	-- HELD WHILE THE LOADING SCREEN IS UP. The car is spawned by the server as
	-- soon as you join -- long before the collision boxes are down or the city
	-- is built -- so without this the car is driveable behind an opaque panel:
	-- you arrive somewhere other than where you spawned because you were leaning
	-- on W, and two scripts fight over the camera the whole time.
	--
	-- A missing attribute reads as false, so a build without the loading screen
	-- behaves exactly as it did before.
	if workspace:GetAttribute("Loading") == true then
		return
	end

	if dt > 0.25 then
		dt = 0.25 -- tabbed away; do not explode
	end
	acc += dt

	local inp = readInput()

	-- STEERING FOLLOWS THE SCREEN, NOT THE CAR.
	--
	-- Reported as "it reverts when the camera looks back". When the car reverses
	-- hard the camera swings round the front so you can see where you are going
	-- -- and from there the car's own left is on the right of the screen. Steer
	-- right and the car visibly went left.
	--
	-- The browser has REV_REAL for the related question of whether reversing
	-- should steer like a real car, and the answer there was no: a thumb on a
	-- stick is not a pair of hands on a wheel. This is the same principle taken
	-- one step further, because the camera moved too -- the input should mean
	-- what it looks like it means, and what it looks like depends on where the
	-- camera is. So the flip is tied to the CAMERA's state, not to the velocity:
	-- the two thresholds and the dead band that stop the camera chattering
	-- (VehicleModel.backView) stop the steering chattering with it, for free.
	if backView then
		inp.steer = -inp.steer
	end

	-- ONE QUERY A FRAME, not one a step. The car moves at most a metre or two
	-- between frames and the query reaches well past that, so the candidate set
	-- is still correct for every sub-step -- and the broadphase lookup is the
	-- most expensive thing in this loop.
	if collisionFolder then
		overlap.FilterDescendantsInstances = { collisionFolder }
		BuildingCollide.near(car.x, car.y, LOOK, S, overlap, nearBoxes)
	end

	local guard = 0
	local lateral = 0
	local wall = 0
	while acc >= STEP and guard < 5 do
		local px, py = car.x, car.y
		local _, vl = VehicleModel.step(car, inp, STEP, onTarmac, REV_REAL)
		lateral = vl
		if #nearBoxes > 0 then
			-- The return is the speed lost INTO the wall, which is exactly what a
			-- bang should be scaled by. It was already being thrown away.
			local hit = BuildingCollide.resolve(car, nearBoxes, px, py)
			if hit > wall then
				wall = hit
			end
		end
		acc -= STEP
		guard += 1
	end

	-- ONE BANG PER COLLISION, NOT ONE PER FRAME OF IT. Leaning on a wall at an
	-- angle resolves every single step, and without a cooldown that is sixty
	-- impacts a second. The browser caps building damage at one hit per 0.45 s
	-- for the same reason and this borrows the number.
	hitCool = math.max(0, hitCool - dt)
	-- QUIETER, AND FROM A HIGHER FLOOR. Reported as "for hits it is too loud":
	-- a bang topped out at 0.9 where the engine topped out at 0.62, so every
	-- scrape was the loudest thing in the game. The ceiling is a third of what
	-- it was, and the threshold is up from 6 to 9 m/s so a kerb is not a crash.
	-- The Effects group halves it again on top.
	if wall > 9 and hitCool <= 0 then
		hitCool = 0.45
		Audio.shot(
			"impact",
			Vector3.new(car.x * S, 1.5 * S, car.y * S),
			math.clamp(wall / 60, 0.05, 0.30),
			0.7 + math.random() * 0.5
		)
	end

	updateSound(dt, lateral)

	if camera.CameraType ~= Enum.CameraType.Scriptable then
		camera.CameraType = Enum.CameraType.Scriptable
	end
	CarBuild.place(model :: Model, car.x, car.y, car.h)
	updateCamera(dt)

	sendAcc += dt
	if sendAcc >= 1 / SEND_HZ then
		sendAcc = 0
		CarState:FireServer(car.x, car.y, car.h)
	end
end)
