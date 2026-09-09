--!strict
-- The wire for Services/WantedService.luau -- attaching it to a car as one
-- appears, taking the two self-reported hit remotes, pushing state out, and
-- running the pursuit tick. The service has no Instances or remotes of its
-- own (same split as IncidentService/IncidentServer, RoleService/RoleServer);
-- this is the half that does.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local Services = script.Parent:WaitForChild("Services")
local WantedService = require(Services:WaitForChild("WantedService"))

local Remotes = ReplicatedStorage:WaitForChild("Remotes")
local Hurt = Remotes:WaitForChild("Hurt") :: RemoteEvent
local PedHit = Remotes:WaitForChild("PedHit") :: RemoteEvent
local WantedState = Remotes:WaitForChild("WantedState") :: RemoteEvent
local CopState = Remotes:WaitForChild("CopState") :: RemoteEvent
local CarCorrection = Remotes:WaitForChild("CarCorrection") :: RemoteEvent

-- ---------------------------------------------------------------- attaching

-- ONE CAR PER PLAYER, and VehicleServer.server.luau is the one place that
-- makes them -- watching the same Cars folder it parents into is what keeps
-- this file from needing to know anything about spawning, sign-on, or shift
-- changes. A car's Owner attribute is set before it is parented (see
-- spawnCar), so ChildAdded always sees it.
local function attachIfOwned(model: Instance)
	if not model:IsA("Model") then
		return
	end
	local owner = model:GetAttribute("Owner")
	local player = if typeof(owner) == "number" then Players:GetPlayerByUserId(owner) else nil
	if player then
		WantedService.attach(player, model)
	end
end

local cars = workspace:WaitForChild("Cars")
cars.ChildAdded:Connect(attachIfOwned)
for _, model in cars:GetChildren() do
	attachIfOwned(model)
end

Players.PlayerRemoving:Connect(function(player)
	WantedService.detach(player)
end)

-- ---------------------------------------------------------------- the reports

Hurt.OnServerEvent:Connect(function(player, why, rel)
	if typeof(why) ~= "string" or typeof(rel) ~= "number" then
		return
	end
	WantedService.reportImpact(player, why, rel)
end)

PedHit.OnServerEvent:Connect(function(player, spd)
	if typeof(spd) ~= "number" then
		return
	end
	WantedService.reportPedHit(player, spd)
end)

-- ---------------------------------------------------------------- outbound

WantedService.changed.Event:Connect(function(player: Player, snap)
	WantedState:FireClient(player, snap)
end)

-- THE CAR HAS ALREADY MOVED by the time this fires (Services/WantedService's
-- own beginDown moves it before firing respawned) -- this is only telling the
-- client's own copy to catch up, the identical message CarCorrection already
-- sends on a rejected position report or on first spawn.
WantedService.respawned.Event:Connect(function(player: Player, x: number, y: number, h: number)
	CarCorrection:FireClient(player, x, y, h)
end)

-- ---------------------------------------------------------------- the tick

-- FIXED-STEP, ACCUMULATED, the same shape Traffic.step's own client-side
-- caller uses -- a pursuit car integrated at a variable dt drifts differently
-- run to run, and capped so a hitch cannot ask this to catch up for ever.
local STEP = 1 / 15
local acc = 0
RunService.Heartbeat:Connect(function(dt)
	acc = math.min(acc + dt, 0.25)
	while acc >= STEP do
		acc -= STEP
		WantedService.step(STEP)
	end

	-- ONLY TO THE PLAYER BEING CHASED. A pursuit is not yet visible to anyone
	-- else in the server, which is a real scope cut from js/game.js's single-
	-- player original -- see Services/WantedService.luau's own header for
	-- what else was cut and why. Sent every tick rather than on change: a cop
	-- car moves every tick it exists, so a diff here would be the same size
	-- as the state.
	for _, player in Players:GetPlayers() do
		local cops = WantedService.copsFor(player)
		if #cops > 0 then
			local out = table.create(#cops)
			for _, k in cops do
				out[#out + 1] = { id = k.id, x = k.car.x, y = k.car.y, h = k.car.h }
			end
			CopState:FireClient(player, out)
		end
	end
end)
