--!strict
-- THE CITY WITH THINGS IN IT: traffic and pedestrians given bodies.
--
-- The simulation is Shared/Traffic and Shared/Pedestrians, which are the
-- browser game's own updateTraffic and walkPed and touch no Instances at all.
-- This file is the other half of that split -- it makes the parts, moves them,
-- and takes them away again -- exactly as VehicleController is the other half
-- of VehicleModel.
--
-- ON THE CLIENT, AND THAT IS A REAL COMPROMISE, so it is worth being plain
-- about rather than burying:
--
--   · every player sees their OWN traffic. Two people driving down the same
--     street do not see the same bus. In a city that is meant to be shared,
--     that is wrong, and it is the first thing that has to change if traffic
--     ever needs to matter to more than one person at a time.
--   · nothing here is authoritative. Knocking somebody down is not scored, does
--     not raise an infraction and is not reported to the server, because a
--     client saying "I ran somebody over" is a client saying anything it likes.
--
-- WHAT IT BUYS is the whole feature at no server cost and no replication: a
-- hundred and ten moving models a frame that the server never sees, in a game
-- whose city is already built client-side for the same reason. The upgrade path
-- is deliberate rather than hypothetical -- the sims are pure and take the
-- player's car as an argument, so moving them behind IncidentService means
-- writing a server script that owns the State and replicating the models, not
-- rewriting the driving. See ROBLOX_PORT_PLAN.md §7.3.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local player = Players.LocalPlayer

local Shared = ReplicatedStorage:WaitForChild("Shared")
local Traffic = require(Shared:WaitForChild("Traffic"))
local Pedestrians = require(Shared:WaitForChild("Pedestrians"))
local PlayerCar = require(Shared:WaitForChild("PlayerCar"))
local CarBuild = require(Shared:WaitForChild("CarBuild"))
local PersonBuild = require(Shared:WaitForChild("PersonBuild"))
local Roles = require(Shared:WaitForChild("Roles"))
local BuildingCollide = require(Shared:WaitForChild("BuildingCollide"))
-- REQUIRED THROUGH A PCALL, WITH A SILENT STUB IF IT FAILS. Sound is
-- optional; the traffic is not. When Shared/Audio threw at module scope --
-- `SoundGroup` is not a property of SoundGroup -- it took this script down
-- with it, and the streets emptied of cars and people.
-- The dependency cannot do that any more: a module that will not load costs
-- the noise and nothing else.
local Audio = (function()
	local ok, m = pcall(require, Shared:WaitForChild("Audio"))
	if ok then
		return m
	end
	warn("[audio] failed to load (" .. tostring(m) .. ") -- carrying on in silence")
	return {
		warm = function() end,
		make = function(): Sound?
			return nil
		end,
		shot = function() end,
		setVolume = function() end,
		getVolume = function(): number
			return 0
		end,
	}
end)()
local Meta = require(ReplicatedStorage:WaitForChild("CityVisual"):WaitForChild("CityMeta"))

local S = Meta.studsPerMetre

-- ---------------------------------------------------------------- the folders

for _, name in { "Traffic", "People" } do
	local stale = workspace:FindFirstChild(name)
	if stale then
		stale:Destroy()
	end
end

local trafficFolder = Instance.new("Folder")
trafficFolder.Name = "Traffic"
trafficFolder.Parent = workspace

local peopleFolder = Instance.new("Folder")
peopleFolder.Name = "People"
peopleFolder.Parent = workspace

local cars = Traffic.new()
local crowd = Pedestrians.new()

-- ---------------------------------------------------------------- buildings

-- SO THAT TRAFFIC DOES NOT DRIVE THROUGH WALLS -- but only the traffic you can
-- see it happen to.
--
-- Resolving every car against the collision volumes is one broadphase query
-- each, and at seventy-eight cars sixty times a second that is five thousand
-- spatial queries a second to keep a bus out of a wall four hundred metres
-- behind you. Traffic follows centrelines by construction and only ever leaves
-- them by being shunted, so the ones worth resolving are the ones near enough
-- for a shunt to have come from you.
--
-- 70 m is a little past where a car is still a car on screen rather than a
-- coloured speck.
local RESOLVE_R = 70

local collisionFolder: Instance? = workspace:FindFirstChild("Collision")
workspace.ChildAdded:Connect(function(child)
	if child.Name == "Collision" then
		collisionFolder = child
	end
end)

local overlap = OverlapParams.new()
overlap.FilterType = Enum.RaycastFilterType.Include
overlap.MaxParts = 64
local nearBoxes: { { x: number, z: number, hx: number, hz: number } } = {}

-- Hoisted rather than closed over inside the loop: this is handed to
-- Traffic.step thirty times a second and a fresh closure each time is the only
-- garbage the tick would otherwise make. `here` is where the player is, written
-- just before the step.
local here = { x = 0, y = 0 }
local function wallStop(car: any, wasX: number, wasY: number)
	if not collisionFolder then
		return
	end
	if (car.x - here.x) ^ 2 + (car.y - here.y) ^ 2 > RESOLVE_R * RESOLVE_R then
		return
	end
	overlap.FilterDescendantsInstances = { collisionFolder :: Instance }
	BuildingCollide.near(car.x, car.y, 14, S, overlap, nearBoxes)
	if #nearBoxes > 0 then
		BuildingCollide.resolve(car, nearBoxes, wasX, wasY)
	end
end

-- ---------------------------------------------------------------- the bodies

local function bodyFor(n: Traffic.Npc): Model
	local m = n.model :: Model?
	if not m then
		-- A LIVERY STRING AND A ROLE ID ARE THE SAME WORD, for the four kinds that
		-- carry a lightbar (fire/police/ambulance/taxi -- taxi's is nil, which is
		-- correct: it wears a sign, not a lightbar). `lorry`/`bus` are liveries
		-- Roles does not know, so this falls back to the default role and no
		-- beacon -- the same "draw nothing extra" result markings() already gives
		-- an unrecognised livery.
		local beacon = if n.livery then Roles.get(n.livery).beacon else nil
		m = CarBuild.npc(n.colour, n.car.l, n.car.w, n.bh, n.boxy, n.livery, beacon)
		;(m :: Model).Parent = trafficFolder
		n.model = m
	end
	return m :: Model
end

local function personFor(p: Pedestrians.Ped): Model
	local m = p.model :: Model?
	if not m then
		m = PersonBuild.new(p.shirt, p.trews, p.skin)
		;(m :: Model).Parent = peopleFolder
		p.model = m
	end
	return m :: Model
end

-- ---------------------------------------------------------------- the tick

-- HEARTBEAT, NOT RENDERSTEPPED. VehicleController integrates the player on
-- RenderStepped and this reads the result, so running after it means the
-- traffic is reacting to where the car actually is this frame rather than to
-- where it was last one. It also means a shunt applied here lands before the
-- next integration picks it up.
-- Thirty a second rather than sixty. Nothing in here is under your hands, the
-- integrator is stable at this step, and it halves the cost of the whole
-- feature. The models are still moved every frame -- what is halved is the
-- thinking, not the drawing.
local STEP = 1 / 30
local acc = 0
local started = 0
local hitCool = 0
local beaconT = 0

-- KNOCKING SOMEBODY DOWN MAKES A NOISE and does nothing else, which is the
-- whole of what this client is allowed to do about it: see the note at the top
-- of this file. It is not scored, not reported and not an infraction, because a
-- client saying "I ran somebody over" is a client saying anything it likes.
local function onKnock(p)
	Audio.shot("impact", Vector3.new(p.x * S, 1.0 * S, p.y * S), 0.18, 1.35)
end

RunService.Heartbeat:Connect(function(dt)
	local pcar = PlayerCar.get()
	if not pcar then
		return
	end
	local c = pcar :: any

	if dt > 0.25 then
		dt = 0.25
	end

	-- A STANDING START FILLS THE WHOLE RING rather than the outer band, because
	-- opening a city with every car out at the cull radius leaves the street you
	-- are actually parked on empty until something happens to drive down it.
	--
	-- A FEW A FRAME, THOUGH. Each spawn is a search over the road index, and
	-- seventy-eight of them plus thirty-four walkers in the frame the car
	-- appears is a hitch landing on top of the one the city build already
	-- costs. Spread over half a second nobody sees it happen.
	--
	-- COUNTED IN FRAMES, not "until the cap is met": a spawn can fail --
	-- nowhere clear on any road it drew -- and a loop that waits for a number
	-- it may never reach would keep searching for ever. After this the ordinary
	-- top-up in Traffic.step fills whatever is short, from the ring.
	if started < 8 then
		started += 1
		Traffic.spawn(cars, c.x, c.y, math.min(10, Traffic.CAP - #cars.cars), true)
		Pedestrians.spawn(crowd, c.x, c.y, math.min(5, Pedestrians.CAP - #crowd.peds))
	end

	acc += dt
	local steps = 0
	while acc >= STEP and steps < 3 do
		acc -= STEP
		steps += 1

		here.x, here.y = c.x, c.y
		Traffic.step(cars, STEP, c, c.x, c.y, wallStop)

		-- The return is the hardest closing speed of the tick. Same cooldown rule
		-- as the wall bang in VehicleController: nose to tail in traffic resolves
		-- on every step, and without it a queue is a machine gun.
		local shunt = Traffic.hitPlayer(cars, c, PlayerCar.MASS)
		hitCool = math.max(0, hitCool - STEP)
		if shunt > 9 and hitCool <= 0 then
			hitCool = 0.6
			-- Same retune as the wall bang in VehicleController: a third of the
			-- old ceiling, and a higher threshold so nose-to-tail in a queue is
			-- not a collision.
			Audio.shot(
				"impact",
				Vector3.new(c.x * S, 1.5 * S, c.y * S),
				math.clamp(shunt / 55, 0.05, 0.32),
				0.8 + math.random() * 0.4
			)
		end

		Pedestrians.step(crowd, STEP, c.x, c.y, c, onKnock)

		-- INSIDE THE SUBSTEP LOOP, not after it. Both sims clear their `gone`
		-- list at the top of every step, so draining it once a frame throws away
		-- everything culled by all but the last substep -- and every one of
		-- those is a model left parented to the world with nothing driving it.
		for _, n in cars.gone do
			if n.model then
				(n.model :: Instance):Destroy()
				n.model = nil
			end
		end
		for _, p in crowd.gone do
			if p.model then
				(p.model :: Instance):Destroy()
				p.model = nil
			end
		end
	end

	-- ---- and draw the rest ----

	-- THE STROBE, ambient rather than gated. RoleUI blinks the PLAYER's own
	-- beacon only while ClientBus.responding is true, because that light means
	-- "this unit is on a call"; a background fire engine or police car has no
	-- such state to report and simply looks like a fire engine or police car,
	-- lit or not, the way js/render3d.js's pushFireBar/pushPolice always are.
	-- Same double-flash phase as RoleUI's, so a background unit and the
	-- player's own read as the same kind of light.
	beaconT += dt
	local ph = (beaconT * 2.4) % 1
	local lit = ph < 0.09 or (ph > 0.16 and ph < 0.25)

	for _, n in cars.cars do
		local m = bodyFor(n)
		CarBuild.place(m, n.car.x, n.car.y, n.car.h, m:GetAttribute("BodyY") :: number)

		local bar = m:FindFirstChild("Beacon")
		if bar and bar:IsA("BasePart") then
			bar.Transparency = if lit then 0 else 0.62
			local light = bar:FindFirstChildOfClass("PointLight")
			if light then
				light.Brightness = if lit then 2.4 else 0
			end
		end
	end

	for _, p in crowd.peds do
		local m = personFor(p)
		-- The stride: a bounce (twice a stride, so both feet's contact reads)
		-- plus the leg/arm swing PersonBuild.place derives from the same p.step.
		-- Both zero out together when struck, so a downed body's limbs hold
		-- still rather than swimming while it lies there.
		local bob = if p.struck then 0 else math.abs(math.sin(p.step)) * 0.045
		local step = if p.struck then 0 else p.step
		PersonBuild.place(m, p.x, p.y, p.h, p.lie, p.pz, bob, step)
	end
end)

-- Clean up on the way out, so a rejoin does not inherit a street full of
-- abandoned buses.
Players.PlayerRemoving:Connect(function(who)
	if who == player then
		trafficFolder:Destroy()
		peopleFolder:Destroy()
	end
end)
