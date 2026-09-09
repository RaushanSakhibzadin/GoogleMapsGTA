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
local RoleService = require(Services:WaitForChild("RoleService"))

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

		-- PER ROLE, not a single headcount. With one kind and one role, "2/3" was
		-- the whole truth about an incident; with three services on a collision
		-- it hides the only thing worth knowing, which is WHICH service is still
		-- missing. This is what lets the card say "needs fire" rather than "1/4".
		local slots = {}
		local total = 0
		for _, s in kind.slots do
			local n = 0
			for _, r in inc.claims do
				if r == s.role then
					n += 1
				end
			end
			slots[#slots + 1] = { role = s.role, max = s.max, filled = n }
			total += s.max
		end

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
			max = total,
			slots = slots,
			competitive = kind.competitive == true,
			marker = kind.marker,
			colour = kind.colour,
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
local function onScene(inc): (number, number?)
	local kind = IncidentTypes[inc.kind]
	local radius = kind.tiers[inc.tier].radius
	local n = 0
	-- WHO, as well as how many. A competitive job is decided by which claimant
	-- arrived, so the count alone is not enough to award one. Once a winner is
	-- locked it is that player who has to be here, and nobody else's arrival
	-- can take the fare back off them.
	local who: number? = inc.winner
	for userId in inc.claims do
		local model = cars:FindFirstChild("Car_" .. userId)
		if model and model:IsA("Model") then
			local p = model:GetPivot().Position
			if (Vector2.new(p.X, p.Z) - Vector2.new(inc.x, inc.z)).Magnitude <= radius then
				n += 1
				if who == nil then
					who = userId
				end
			end
		end
	end
	if inc.winner ~= nil then
		-- The locked winner counts only while they are actually here.
		local model = cars:FindFirstChild("Car_" .. inc.winner)
		local here = false
		if model and model:IsA("Model") then
			local p = model:GetPivot().Position
			here = (Vector2.new(p.X, p.Z) - Vector2.new(inc.x, inc.z)).Magnitude <= radius
		end
		who = if here then inc.winner else nil
	end
	return n, who
end

-- ---------------------------------------------------------------- dispatch

local rng = Random.new()

-- WHAT THE BOARD IS ALLOWED TO PUT ON IT, and it is decided from the district
-- rather than written down. A kind whose roles cannot be signed on here is a
-- kind nobody can ever clear -- it would sit on the board for its whole life,
-- take up one of the four slots and expire. So a kind is dispatchable only if
-- at least one of its roles has a depot in this district, and the FIRST slot's
-- role is the one that has to: that is the service the job is fundamentally
-- for, and a collision with no police is not a collision anybody can start.
--
-- Weighted rather than uniform. The emergencies are the game; the fare and the
-- parcel are what there is to do between them, and at equal weight five kinds
-- over four board slots means the board is mostly errands.
local MIX = {
	{ kind = "fire", weight = 3 },
	{ kind = "medical", weight = 3 },
	{ kind = "collision", weight = 3 },
	{ kind = "fare", weight = 2 },
	{ kind = "parcel", weight = 2 },
}

local dispatchable: { { kind: string, weight: number } } = {}
local totalWeight = 0
for _, entry in MIX do
	local lead = IncidentTypes[entry.kind].slots[1].role
	if RoleService.available(lead) then
		dispatchable[#dispatchable + 1] = entry
		totalWeight += entry.weight
	end
end

local function pickKind(): string?
	if totalWeight == 0 then
		return nil
	end
	local r = rng:NextNumber() * totalWeight
	for _, entry in dispatchable do
		r -= entry.weight
		if r <= 0 then
			return entry.kind
		end
	end
	return dispatchable[#dispatchable].kind
end

local function spawnOne()
	local kindId = pickKind()
	if not kindId then
		return
	end
	local site = Sites[rng:NextInteger(1, #Sites)]
	IncidentService.create(kindId, site.x, site.z, site.name)
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
		-- A district that can staff nothing would otherwise spin this loop once a
		-- second for ever, achieving nothing each time.
		task.wait(if totalWeight == 0 then 60 elseif n < WANT then 1 else SPAWN_EVERY)
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
		return false, "refuse.badRequest"
	end
	if #token > 64 or #incidentId > 64 then
		return false, "refuse.badRequest"
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

-- ---------------------------------------------------------------- shifts

-- CHANGING SHIFT DROPS THE JOB, and it has to: a slot is claimed as a role, and
-- keeping it after signing off would leave a courier holding the fire slot on a
-- flat fire that nobody else can now take.
--
-- WIRED HERE RATHER THAN INSIDE EITHER SERVICE, so the require between them
-- stays one-way -- IncidentService reads RoleService, never the reverse. This
-- script is the one place that knows about both.
RoleService.changed.Event:Connect(function(player: Player)
	IncidentService.release(player.UserId)
end)

local kinds = {}
for _, entry in dispatchable do
	kinds[#kinds + 1] = entry.kind
end
print(
	("[dispatch] %d sites, %d incidents wanted, dispatching %s"):format(
		#Sites,
		WANT,
		if #kinds > 0 then table.concat(kinds, ", ") else "NOTHING -- no role has a depot here"
	)
)
