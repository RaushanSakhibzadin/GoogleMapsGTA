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
-- Consequence: buildings do not stop the car yet. Collision is the next piece
-- of M1 -- the boxes are baked and in Workspace, but the model has no
-- buildingCollide() ported to it, so at the moment you drive through walls.

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

-- ---------------------------------------------------------------- the loop

local STEP = 1 / 60
local acc = 0
local sendAcc = 0

local onTarmac = function(x: number, y: number): boolean
	return Tarmac.nearRoad(x, y)
end

camera.CameraType = Enum.CameraType.Scriptable

RunService.RenderStepped:Connect(function(dt)
	if not model then
		model = findMine()
		if not model then
			return
		end
	end

	if dt > 0.25 then
		dt = 0.25 -- tabbed away; do not explode
	end
	acc += dt

	local inp = readInput()
	local guard = 0
	while acc >= STEP and guard < 5 do
		VehicleModel.step(car, inp, STEP, onTarmac, REV_REAL)
		acc -= STEP
		guard += 1
	end

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
