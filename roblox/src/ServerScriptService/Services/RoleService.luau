--!strict
-- WHO IS ON WHICH SHIFT, and whether they were anywhere they could sign on.
--
-- THE SERVER DECIDES WHERE YOU ARE STANDING. The client asks for a role and
-- nothing else -- it does not say where it is, because a claim that trusts a
-- client-supplied position is a claim you can make from anywhere. The position
-- comes off the car model the server itself moves, which is the same source
-- IncidentServer's onScene() uses to decide whether somebody actually turned up.
--
-- NO YIELDS in signOn, for the same reason IncidentService.tryClaim has none:
-- it is read, validate, mutate, return. It is not a race in the way a slot is --
-- a role is per-player and nobody contends for it -- but it is called from a
-- RemoteFunction, and a yield inside one is an interleaving point that would
-- let a second request from the same client land in the middle of the first.
--
-- WHERE YOU PULL UP IS NOT THE DEPOT. Every depot carries a GATE, baked by
-- tools/roblox/4-collide.mjs: the nearest drivable point to it. The browser
-- found out why in play -- "fire stations have no roads to come close to", and
-- on THIS district's fire station the nearest road is 51 m from the building.
-- Being at either counts.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local Roles = require(Shared:WaitForChild("Roles"))
local Depots = require(Shared:WaitForChild("Depots"))
local Meta = require(ReplicatedStorage:WaitForChild("CityVisual"):WaitForChild("CityMeta"))

local RoleService = {}

export type Depot = {
	kind: string,
	x: number,
	z: number,
	gx: number?,
	gz: number?,
	name: string,
}

-- Close enough to have pulled up at it. JOB_RANGE is 22 m in the browser and
-- this is the same distance in studs -- the depot is a point at the centre of a
-- building, so it has to clear the building itself.
local SIGN_RANGE = 22 * Meta.studsPerMetre
local SIGN_RANGE_SQ = SIGN_RANGE * SIGN_RANGE

-- Four a second, the same rate the claim path allows. Generous for a button.
local SIGN_RATE = 0.25

local roles: { [number]: string } = {}
local lastSignAt: { [number]: number } = {}

RoleService.changed = Instance.new("BindableEvent")

-- ---------------------------------------------------------------- the district

-- WHICH ROLES THIS DISTRICT CAN ACTUALLY SIGN ON, worked out once from the
-- depots the bake found and then never again. A role with no depot here is not
-- a bug and is not hidden: it is printed at boot and refused with a reason, so
-- "why is there no ambulance" has an answer in the log rather than in the code.
local have: { [string]: boolean } = {}
for _, d in Depots :: { Depot } do
	have[d.kind] = true
end

RoleService.backing = {} :: { [string]: string } -- role id -> depot kind, or absent

for _, id in Roles.ORDER do
	local kind = Roles.depotKind(Roles.get(id), have)
	if kind then
		RoleService.backing[id] = kind
	end
end

function RoleService.available(id: string): boolean
	return RoleService.backing[id] ~= nil
end

-- Every depot that signs somebody on, with the role it signs them on to. Sent
-- to clients once at join so the maps can blip them and the prompt can name
-- them; a repair garage is in Depots too and is not one of these.
function RoleService.signOnDepots(): { { kind: string, role: string, x: number, z: number, gx: number?, gz: number?, name: string } }
	local byKind: { [string]: string } = {}
	for role, kind in RoleService.backing do
		if kind ~= "" and not byKind[kind] then
			byKind[kind] = role
		end
	end
	local out = {}
	for _, d in Depots :: { Depot } do
		local role = byKind[d.kind]
		if role then
			out[#out + 1] =
				{ kind = d.kind, role = role, x = d.x, z = d.z, gx = d.gx, gz = d.gz, name = d.name }
		end
	end
	return out
end

-- ---------------------------------------------------------------- the state

function RoleService.roleOf(userId: number): string
	return roles[userId] or Roles.DEFAULT
end

-- ---------------------------------------------------------------- sign on

local cars: Instance? = nil

local function carPos(userId: number): Vector2?
	if not cars then
		cars = workspace:FindFirstChild("Cars")
	end
	local folder = cars
	if not folder then
		return nil
	end
	local model = folder:FindFirstChild("Car_" .. userId)
	if model and model:IsA("Model") then
		local p = model:GetPivot().Position
		return Vector2.new(p.X, p.Z)
	end
	return nil
end

-- The depot you are standing at that signs on `role`, or nil. Both the building
-- and its gate count; nothing here yields.
local function depotFor(role: string, at: Vector2): Depot?
	local kind = RoleService.backing[role]
	if not kind or kind == "" then
		return nil
	end
	for _, d in Depots :: { Depot } do
		if d.kind == kind then
			local dx, dz = d.x - at.X, d.z - at.Y
			if dx * dx + dz * dz <= SIGN_RANGE_SQ then
				return d
			end
			if d.gx then
				local gx, gz = (d.gx :: number) - at.X, (d.gz :: number) - at.Y
				if gx * gx + gz * gz <= SIGN_RANGE_SQ then
					return d
				end
			end
		end
	end
	return nil
end

-- THE CRITICAL SECTION. No yields between the check and the write.
--
-- WHAT IS ON OFFER IS THE CLIENT'S QUESTION, not this one's. RoleUI works out
-- what to draw from the depot list it was sent, because the prompt has to appear
-- the instant you stop and a round trip is not instant. This is the only place
-- that decides anything, and it re-derives the position from the model the
-- server itself moves rather than believing a word of the request.
function RoleService.signOn(player: Player, roleId: string): (boolean, string)
	local userId = player.UserId

	local now = os.clock()
	if now - (lastSignAt[userId] or -1) < SIGN_RATE then
		return false, "too fast"
	end
	lastSignAt[userId] = now

	if not Roles.exists(roleId) then
		return false, "no such shift"
	end
	if RoleService.roleOf(userId) == roleId then
		return true, "already yours"
	end
	if not RoleService.available(roleId) then
		return false, "no depot for that shift in this district"
	end

	-- The default shift needs no depot -- it is what signing OFF means, and it
	-- has to be possible from wherever the last shift left you.
	if RoleService.backing[roleId] ~= "" then
		local at = carPos(userId)
		if not at then
			return false, "no vehicle"
		end
		if not depotFor(roleId, at) then
			return false, "not at a depot"
		end
	end

	roles[userId] = roleId
	RoleService.changed:Fire(player, roleId)
	return true, "signed on"
end

Players.PlayerRemoving:Connect(function(player)
	roles[player.UserId] = nil
	lastSignAt[player.UserId] = nil
end)

do
	local on, off = {}, {}
	for _, id in Roles.ORDER do
		local kind = RoleService.backing[id]
		if kind then
			on[#on + 1] = id .. (if kind == "" then " (anywhere)" else " @ " .. kind)
		else
			off[#off + 1] = id .. " (wants " .. table.concat(Roles.get(id).depot, " or ") .. ")"
		end
	end
	print(("[shifts] %d playable: %s"):format(#on, table.concat(on, ", ")))
	if #off > 0 then
		print(("[shifts] %d with no depot in this district: %s"):format(#off, table.concat(off, ", ")))
	end
end

return RoleService
