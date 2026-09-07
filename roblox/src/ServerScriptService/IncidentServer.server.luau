--!strict
-- Dispatch: keep incidents on the board, drive them, pay for them.
--
-- The pieces are in Services/: IncidentService owns the state and the race-safe
-- claim path, ProfileService owns money. This is the loop that connects them to
-- the world -- where incidents appear, who counts as on scene, and what goes
-- over the wire.
--
-- DELTAS, NOT A SNAPSHOT PER FRAME. Incidents are small but there can be a
-- dozen, and firing the lot at every progress tick is a needless multiple of
-- the bandwidth. A full board goes out on join and on change; progress rides a
-- much lighter message.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local IncidentTypes = require(Shared:WaitForChild("IncidentTypes"))
local Sites = require(Shared:WaitForChild("Sites"))

local Services = script.Parent:WaitForChild("Services")
local IncidentService = require(Services:WaitForChild("IncidentService"))
local ProfileService = require(Services:WaitForChild("ProfileService"))

local Remotes = ReplicatedStorage:WaitForChild("Remotes")
local Board = Remotes:WaitForChild("IncidentBoard") :: RemoteEvent
local Claim = Remotes:WaitForChild("ClaimSlot") :: RemoteFunction
local Wallet = Remotes:WaitForChild("Wallet") :: RemoteEvent

-- How many incidents are on the board at once. Enough that there is always one
-- worth driving to and few enough that the map is not a christmas tree.
local WANT = 4
local SPAWN_EVERY = 12

-- ---------------------------------------------------------------- the board

local function pack()
	local out = {}
	for id, inc in IncidentService.all() do
		local kind = IncidentTypes[inc.kind]
		local tier = kind.tiers[inc.tier]
		out[#out + 1] = {
			id = id,
			kind = inc.kind,
			title = kind.title,
			label = tier.label,
			detail = tier.detail,
			x = inc.x,
			z = inc.z,
			name = inc.name,
			filled = inc.filled,
			max = kind.slots[1].max,
			progress = inc.progress,
			state = inc.state,
			pay = tier.pay,
			radius = tier.radius,
		}
	end
	return out
end

local function broadcast()
	Board:FireAllClients(pack())
end

IncidentService.changed.Event:Connect(broadcast)

-- ---------------------------------------------------------------- on scene

local cars = workspace:WaitForChild("Cars")

-- How many of an incident's claimants are actually standing at it. This is what
-- makes progress mean something: claiming a slot and driving the other way must
-- not finish a job for the people who did turn up.
local function onScene(inc): number
	local kind = IncidentTypes[inc.kind]
	local radius = kind.tiers[inc.tier].radius
	local n = 0
	for userId in inc.claims do
		local model = cars:FindFirstChild("Car_" .. userId)
		if model and model:IsA("Model") then
			local p = model:GetPivot().Position
			if (Vector2.new(p.X, p.Z) - Vector2.new(inc.x, inc.z)).Magnitude <= radius then
				n += 1
			end
		end
	end
	return n
end

-- ---------------------------------------------------------------- dispatch

local rng = Random.new()

local function spawnOne()
	local site = Sites[rng:NextInteger(1, #Sites)]
	IncidentService.create("fire", site.x, site.z, site.name)
end

task.spawn(function()
	while true do
		local n = 0
		for _ in IncidentService.all() do
			n += 1
		end
		if n < WANT then
			spawnOne()
		end
		task.wait(if n < WANT then 1 else SPAWN_EVERY)
	end
end)

-- ---------------------------------------------------------------- payout

IncidentService.resolved.Event:Connect(function(id, kindId, tierIndex, claims, pay)
	for userId in claims do
		local player = Players:GetPlayerByUserId(userId)
		if player then
			-- Yields (a DataStore write may be queued behind this) are fine
			-- HERE: the critical section is long since returned.
			ProfileService.award(player, pay, kindId)
		end
	end
	broadcast()
end)

ProfileService.changed.Event:Connect(function(player, profile)
	Wallet:FireClient(player, profile.money)
end)

-- ---------------------------------------------------------------- players

local function onJoin(player: Player)
	ProfileService.load(player)
	Board:FireClient(player, pack())
end

Players.PlayerAdded:Connect(onJoin)
for _, p in Players:GetPlayers() do
	task.spawn(onJoin, p)
end
Players.PlayerRemoving:Connect(function(player)
	ProfileService.unload(player)
end)

-- ---------------------------------------------------------------- claims

-- The remote is a plain pass-through to the critical section. Everything it
-- could get wrong -- a bad id, a role that is not there, a full slot, a client
-- spamming it -- is decided in there rather than here, so there is exactly one
-- place to read to know whether claiming is safe.
Claim.OnServerInvoke = function(player: Player, incidentId, role, token)
	if type(incidentId) ~= "string" or type(role) ~= "string" or type(token) ~= "string" then
		return false, "bad request"
	end
	if #token > 64 or #incidentId > 64 then
		return false, "bad request"
	end
	return IncidentService.tryClaim(player, incidentId, role, token)
end

-- ---------------------------------------------------------------- the loop

local acc = 0
RunService.Heartbeat:Connect(function(dt)
	IncidentService.step(dt, onScene)
	-- Progress is broadcast on its own timer rather than on every change, or a
	-- fire with three crews on it sends sixty messages a second.
	acc += dt
	if acc >= 0.25 then
		acc = 0
		broadcast()
	end
end)

print(("[dispatch] %d sites, %d incidents wanted"):format(#Sites, WANT))
