--!strict
-- Incidents: who is on one, and whether they are allowed to be.
--
-- THE CLAIM PATH IS A CRITICAL SECTION AND IT MUST NOT YIELD. That is the whole
-- of the race safety, and in Luau it is easy to get wrong by accident.
--
-- A server script is single-threaded, so nothing can interleave with a run of
-- straight-line code. But EVERY yield is an interleaving point: task.wait,
-- :InvokeClient, a DataStore call, even a pcall around something that yields.
-- Check-then-write with a yield between them is two players both seeing a free
-- slot and both taking it.
--
-- So tryClaim() below reads, validates, mutates and returns with no yield of
-- any kind between the check and the write. Replication is fired AFTER the
-- mutation, never inside it. Anything that has to yield -- a payout, a
-- profile write -- is queued and runs later.
--
-- Three more things the plan asks for, all of them here:
--   · claims are IDEMPOTENT BY TOKEN, so a client retry is a no-op rather than
--     a double claim
--   · a player holds ONE slot at a time across all incidents, and taking a
--     second releases the first in the same section
--   · claims are rate limited, so a client cannot starve the section
--
-- AND AN INCIDENT ALMOST NEVER FAILS BECAUSE SOMEBODY LEFT. A stale slot is
-- released and the incident RE-TIERS DOWNWARD rather than collapsing -- three
-- people become two, and the job becomes the two-person version of itself.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local IncidentTypes = require(ReplicatedStorage:WaitForChild("Shared"):WaitForChild("IncidentTypes"))

local IncidentService = {}

export type Incident = {
	id: string,
	kind: string,
	x: number,
	z: number,
	name: string,
	createdAt: number,
	expiresAt: number,
	state: string, -- "open" | "engaged" | "resolved" | "expired"
	claims: { [number]: string }, -- UserId -> role
	filled: number,
	tier: number,
	progress: number, -- 0..1 of the tier's work
}

local incidents: { [string]: Incident } = {}
local held: { [number]: string } = {} -- UserId -> incident id
local seenTokens: { [string]: string } = {} -- token -> incident id it claimed
local lastClaimAt: { [number]: number } = {}

local nextId = 0

-- Four a second is generous for a button and ungenerous for a script.
local CLAIM_RATE = 0.25

IncidentService.changed = Instance.new("BindableEvent")
IncidentService.resolved = Instance.new("BindableEvent")

function IncidentService.all(): { [string]: Incident }
	return incidents
end

function IncidentService.create(kindId: string, x: number, z: number, name: string): Incident?
	local kind = IncidentTypes[kindId]
	if not kind then
		return nil
	end
	nextId += 1
	local id = kindId .. "_" .. nextId
	local now = os.clock()
	local inc: Incident = {
		id = id,
		kind = kindId,
		x = x,
		z = z,
		name = name,
		createdAt = now,
		expiresAt = now + kind.life,
		state = "open",
		claims = {},
		filled = 0,
		tier = 1,
		progress = 0,
	}
	incidents[id] = inc
	IncidentService.changed:Fire()
	return inc
end

-- Re-choose the tier for the current headcount. Called on every claim and
-- release, so an incident that loses a responder becomes the smaller job rather
-- than an unfinishable version of the bigger one.
local function retier(inc: Incident)
	local kind = IncidentTypes[inc.kind]
	local _, index = IncidentTypes.tierFor(kind, math.max(inc.filled, 1))
	inc.tier = index
end

-- Free whatever slot this player holds. NO YIELDS -- it is called from inside
-- the critical section below as well as from PlayerRemoving.
local function releaseInner(userId: number): string?
	local id = held[userId]
	if not id then
		return nil
	end
	held[userId] = nil
	local inc = incidents[id]
	if inc and inc.claims[userId] then
		inc.claims[userId] = nil
		inc.filled = math.max(0, inc.filled - 1)
		if inc.filled == 0 and inc.state == "engaged" then
			-- nobody left on it; back on the board rather than failed
			inc.state = "open"
			inc.progress = 0
		end
		retier(inc)
	end
	return id
end

function IncidentService.release(userId: number)
	local id = releaseInner(userId)
	if id then
		IncidentService.changed:Fire()
	end
end

-- THE CRITICAL SECTION. Read, validate, mutate, return. No task.wait, no
-- remote round trip, no DataStore, nothing that yields, anywhere between the
-- check and the write.
function IncidentService.tryClaim(
	player: Player,
	incidentId: string,
	role: string,
	token: string
): (boolean, string)
	local userId = player.UserId

	-- Idempotent: the same token twice is the same claim, not two.
	local already = seenTokens[token]
	if already then
		return already == incidentId, "duplicate"
	end

	local now = os.clock()
	if now - (lastClaimAt[userId] or -1) < CLAIM_RATE then
		return false, "too fast"
	end
	lastClaimAt[userId] = now

	local inc = incidents[incidentId]
	if not inc then
		return false, "no such incident"
	end
	if inc.state ~= "open" and inc.state ~= "engaged" then
		return false, "closed"
	end

	local kind = IncidentTypes[inc.kind]
	local slot: IncidentTypes.Slot? = nil
	for _, s in kind.slots do
		if s.role == role then
			slot = s
			break
		end
	end
	if not slot then
		return false, "no such role here"
	end

	if inc.claims[userId] then
		return true, "already yours"
	end

	local inRole = 0
	for _, r in inc.claims do
		if r == role then
			inRole += 1
		end
	end
	if inRole >= (slot :: IncidentTypes.Slot).max then
		return false, "role full"
	end

	-- ONE SLOT AT A TIME, released in the same section so there is no instant
	-- where the player holds two or none.
	releaseInner(userId)

	inc.claims[userId] = role
	inc.filled += 1
	held[userId] = incidentId
	seenTokens[token] = incidentId
	if inc.state == "open" then
		inc.state = "engaged"
	end
	retier(inc)

	-- Replication AFTER the mutation, never inside it.
	IncidentService.changed:Fire()
	return true, "claimed"
end

function IncidentService.heldBy(userId: number): string?
	return held[userId]
end

-- Progress, expiry and resolution. Driven from a heartbeat by the server
-- script; separated from the claim path because this one is allowed to yield.
function IncidentService.step(dt: number, onScene: (Incident) -> number)
	local now = os.clock()
	local dirty = false

	for id, inc in incidents do
		if inc.state == "open" then
			if now > inc.expiresAt then
				inc.state = "expired"
				incidents[id] = nil
				dirty = true
			end
		elseif inc.state == "engaged" then
			local kind = IncidentTypes[inc.kind]
			local tier = kind.tiers[inc.tier]
			local present = onScene(inc)

			-- WORK SCALES WITH WHO IS ACTUALLY THERE, not with who claimed.
			-- Claiming a slot and driving the other way should not finish a job.
			if present > 0 then
				inc.progress += (dt * present) / tier.work
				dirty = true
				if inc.progress >= 1 then
					inc.state = "resolved"
					incidents[id] = nil
					for userId in inc.claims do
						held[userId] = nil
					end
					IncidentService.resolved:Fire(inc.id, inc.kind, inc.tier, inc.claims, tier.pay)
				end
			end
		end
	end

	if dirty then
		IncidentService.changed:Fire()
	end
end

Players.PlayerRemoving:Connect(function(player)
	IncidentService.release(player.UserId)
	lastClaimAt[player.UserId] = nil
end)

return IncidentService
