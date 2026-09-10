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
-- SAFE TO REQUIRE FROM THE CRITICAL SECTION, and the direction matters: this
-- module reads RoleService and RoleService reads nothing back. A player's role
-- is a table lookup, so the "are you on that shift" check costs the claim path
-- nothing and, more to the point, cannot yield. The other direction -- releasing
-- a slot when somebody changes shift -- is wired up in IncidentServer off
-- RoleService.changed, precisely so that this require stays one-way.
local RoleService = require(script.Parent:WaitForChild("RoleService"))

local IncidentService = {}

export type Incident = {
	id: string,
	kind: string,
	x: number, -- the pickup / scene location. Set once, at create, and never moved --
	z: number, -- a twoStage kind's drop point lives in dropX/dropZ instead, precisely so
	-- forfeitInner (a departing winner) can put the objective back where it started
	-- without having to remember where "started" was.
	name: string,
	stage: string, -- "pickup" | "drop". Only ever "drop" for a Kind.twoStage incident
	-- whose pickup leg is done; every other incident is "pickup" for its whole life.
	dropX: number?,
	dropZ: number?,
	dropName: string?,
	createdAt: number,
	expiresAt: number,
	state: string, -- "open" | "engaged" | "resolved" | "expired"
	claims: { [number]: string }, -- UserId -> role
	filled: number,
	tier: number,
	progress: number, -- 0..1 of the current leg's work
	-- Competitive kinds only: whoever reached it first. Locked the moment
	-- somebody is on scene and never reopened by an ordinary release, so a race
	-- is decided once -- see releaseInner and forfeitInner for the two different
	-- reasons a slot can come free and why only one of them clears this.
	winner: number?,
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
		stage = "pickup",
		dropX = nil,
		dropZ = nil,
		dropName = nil,
		createdAt = now,
		expiresAt = now + kind.life,
		state = "open",
		claims = {},
		filled = 0,
		tier = 1,
		progress = 0,
		winner = nil,
	}
	incidents[id] = inc
	IncidentService.changed:Fire()
	return inc
end

-- WHERE THE OBJECTIVE ACTUALLY IS, for the two callers that have to point a
-- player at it: `onScene` (is anyone there yet) and `pack` (what the client
-- draws a marker over). One function so the two can never disagree about it.
function IncidentService.target(inc: Incident): (number, number)
	if inc.stage == "drop" then
		return inc.dropX :: number, inc.dropZ :: number
	end
	return inc.x, inc.z
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
		-- A COMPETITIVE JOB THAT HAS BEEN WON DOES NOT GO BACK ON THE BOARD. The
		-- winner leaving mid-payout would otherwise re-offer a fare that has
		-- already been picked up.
		if inc.filled == 0 and inc.state == "engaged" and inc.winner == nil then
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

-- A DEPARTING WINNER IS NOT COMING BACK TO FINISH IT. `winner` survives an
-- ordinary release on purpose (above) so a driver who claims a second job by
-- mistake does not un-award a fare they already reached -- but that guard
-- turns into a leak the moment the winner is actually gone: the incident sits
-- "engaged" forever, present() finds nobody, progress never moves, and it
-- never expires (expiry is only checked in "open") or leaves the board. Ported
-- concern is the same one that made re-tiering the design in the first place
-- (§4.6: a slot going stale should degrade the incident, not fail it) -- this
-- is that rule applied to the one slot re-tiering does not cover, the locked
-- winner of a race.
--
-- ONLY for a genuine goodbye: PlayerRemoving, and a shift change (which is the
-- same thing for the job they were on -- they cannot re-claim it under a role
-- they no longer hold). NOT called from anywhere the claim path itself can
-- reach, which is what keeps this from re-opening the "mid-payout" case
-- releaseInner's own comment is about.
local function forfeitInner(userId: number)
	releaseInner(userId)
	for _, inc in incidents do
		if inc.winner == userId and inc.state == "engaged" then
			inc.winner = nil
			-- BACK TO THE PICKUP, not left sitting at the drop point a fare
			-- nobody is driving to any more would otherwise dangle at.
			inc.stage = "pickup"
			inc.dropX, inc.dropZ, inc.dropName = nil, nil, nil
			inc.progress = 0
			if inc.filled == 0 then
				-- Nobody else was racing for it either; back on the board.
				inc.state = "open"
			end
			-- If other racers are still claimed, the incident stays "engaged"
			-- with no winner -- exactly an incident nobody has reached yet,
			-- which is the truth, and the next arrival crowns a new one.
		end
	end
end

function IncidentService.forfeit(userId: number)
	forfeitInner(userId)
	IncidentService.changed:Fire()
end

-- THE CRITICAL SECTION. Read, validate, mutate, return. No task.wait, no
-- remote round trip, no DataStore, nothing that yields, anywhere between the
-- check and the write.
--
-- EVERY REFUSAL STRING BELOW IS A Shared/Loc.luau KEY, not English -- it
-- crosses Remotes.ClaimSlot to DispatchUI exactly as it always did, and only
-- the card that shows it now calls Loc.get first. The two on a successful
-- claim ("duplicate", "already yours", "claimed") are NOT keys and never
-- will be: DispatchUI only reads `why` on the false branch, so nothing ever
-- displays them and there is nothing to translate.
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
		return false, "refuse.tooFast"
	end
	lastClaimAt[userId] = now

	local inc = incidents[incidentId]
	if not inc then
		return false, "refuse.noSuchIncident"
	end
	if inc.state ~= "open" and inc.state ~= "engaged" then
		return false, "refuse.closed"
	end

	local kind = IncidentTypes[inc.kind]
	local slot = IncidentTypes.slotFor(kind, role)
	if not slot then
		return false, "refuse.noSuchRoleHere"
	end

	-- YOU MAY ONLY CLAIM THE SHIFT YOU ARE ON, and this is the check that makes
	-- the whole roster mean anything. Without it `role` is a string the client
	-- picked, and a courier could take the fire slot by asking for it -- the
	-- depot would be decoration and every incident would be open to everyone.
	--
	-- A table lookup, so it costs the section nothing and cannot yield.
	if RoleService.roleOf(userId) ~= role then
		return false, "refuse.notOnThatShift"
	end

	if inc.claims[userId] then
		return true, "already yours"
	end

	-- A COMPETITIVE JOB THAT SOMEBODY HAS ALREADY REACHED IS OVER, whatever the
	-- board still says: it lingers for the three seconds of its own work and a
	-- claim landing in that window would be a claim on a fare already taken.
	if inc.winner ~= nil then
		return false, "refuse.alreadyTaken"
	end

	local inRole = 0
	for _, r in inc.claims do
		if r == role then
			inRole += 1
		end
	end
	if inRole >= (slot :: IncidentTypes.Slot).max then
		return false, "refuse.roleFull"
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
-- `onScene` answers two questions about one incident: how many of its claimants
-- are standing at it, and which one of them is (any one -- for a competitive job
-- it is the winner, because the first frame anybody is there is the frame it is
-- decided).
function IncidentService.step(
	dt: number,
	onScene: (Incident) -> (number, number?),
	pickDrop: (Incident) -> (number, number, string)
)
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
			local present, someone = onScene(inc)

			-- CLAIM IS NOT AWARD. Everyone on the shift can be holding a slot on
			-- the same fare; the first to actually arrive takes it, and from that
			-- instant nobody else's presence counts towards finishing it. That is
			-- the whole of "competitive" -- it is a race rather than a rota, and
			-- the losers simply stop being on it.
			if kind.competitive then
				if inc.winner == nil then
					inc.winner = someone
					if someone ~= nil then
						dirty = true
					end
				end
				present = if inc.winner ~= nil and someone == inc.winner then 1 else 0
			end

			-- WORK SCALES WITH WHO IS ACTUALLY THERE, not with who claimed.
			-- Claiming a slot and driving the other way should not finish a job.
			if present > 0 then
				inc.progress += (dt * present) / tier.work
				dirty = true
				if inc.progress >= 1 then
					if kind.twoStage and inc.stage ~= "drop" then
						-- PICKED UP, NOT RESOLVED. The pickup leg's work is done; the
						-- job moves to a drop point elsewhere in the district and
						-- starts a second leg on the same claim -- the race was
						-- already decided at the pickup, so carrying it is not raced
						-- for again.
						local dx, dz, dn = pickDrop(inc)
						inc.dropX, inc.dropZ, inc.dropName = dx, dz, dn
						inc.stage = "drop"
						inc.progress = 0
					else
						inc.state = "resolved"
						incidents[id] = nil
						for userId in inc.claims do
							held[userId] = nil
						end
						-- Paid to the winner alone on a competitive job, to everybody
						-- who claimed on a dispatched one.
						local paid = inc.claims
						if kind.competitive then
							local w = inc.winner
							paid = if w then { [w] = inc.claims[w] } else {}
						end
						IncidentService.resolved:Fire(inc.id, inc.kind, inc.tier, paid, tier.pay)
					end
				end
			end
		end
	end

	if dirty then
		IncidentService.changed:Fire()
	end
end

Players.PlayerRemoving:Connect(function(player)
	IncidentService.forfeit(player.UserId)
	lastClaimAt[player.UserId] = nil
end)

return IncidentService
