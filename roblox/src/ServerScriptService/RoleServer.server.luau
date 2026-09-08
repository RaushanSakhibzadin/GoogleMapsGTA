--!strict
-- Shifts: the remote, the broadcast, and the vehicle that comes with the job.
--
-- RoleService owns the state and the "were you actually at a depot" check. This
-- is the loop that connects it to the world -- one remote in, one message out,
-- and the car redressed as whatever the shift drives.
--
-- WHAT THE CLIENT IS TOLD, and it is deliberately more than "you are a
-- firefighter now":
--
--   · WHICH ROLES THIS DISTRICT CAN SIGN ON. Belgrade has no taxi rank and no
--     amenity=hospital, so two of the five run on fallback depots and any one
--     of them could have none at all -- the client has to be able to say
--     "there is no ambulance work in this city" rather than offering a button
--     that always fails.
--   · WHERE THE DEPOTS ARE. The maps blip them and the prompt names them, and
--     both need the list before you are anywhere near one.
--
-- Sent once at join and again on every change, because it is a few dozen
-- numbers and it never changes after that.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local Roles = require(Shared:WaitForChild("Roles"))
local CarBuild = require(Shared:WaitForChild("CarBuild"))

local RoleService = require(script.Parent:WaitForChild("Services"):WaitForChild("RoleService"))

local Remotes = ReplicatedStorage:WaitForChild("Remotes")
local SignOn = Remotes:WaitForChild("SignOn") :: RemoteFunction
local RoleState = Remotes:WaitForChild("RoleState") :: RemoteEvent

local depots = RoleService.signOnDepots()

local playable: { string } = {}
for _, id in Roles.ORDER do
	if RoleService.available(id) then
		playable[#playable + 1] = id
	end
end

local function tell(player: Player)
	RoleState:FireClient(player, {
		role = RoleService.roleOf(player.UserId),
		playable = playable,
		depots = depots,
	})
end

-- ---------------------------------------------------------------- the vehicle

-- THE CAR IS REDRESSED, NOT REPLACED. Destroying it and building another would
-- be simpler to write and would break three things at once: the model is what
-- the player's ReplicationFocus points at, what every other client that has
-- already found this car is holding, and what VehicleController drives. So the
-- hull survives the shift change and everything bolted to it does not.
--
-- The paint a courier wears is their own, which is why this reaches for the
-- attribute the car was built with rather than a colour from the role table:
-- signing off should give you back the car you arrived in.
local function dress(player: Player, roleId: string)
	local cars = workspace:FindFirstChild("Cars")
	local model = cars and cars:FindFirstChild("Car_" .. player.UserId)
	if not (model and model:IsA("Model")) then
		return
	end
	local role = Roles.get(roleId)
	local own = (model :: Model):GetAttribute("OwnColour")
	local colour = role.colour or (if typeof(own) == "Color3" then own :: Color3 else Color3.new(1, 1, 1))
	CarBuild.dress(model :: Model, colour, role.body, role.livery, role.beacon)
	-- READ BY THE CLIENT that drives this car, which is the one place the
	-- handling numbers can be applied: the vehicle model runs there.
	;(model :: Model):SetAttribute("Role", roleId)
end

RoleService.changed.Event:Connect(function(player: Player, roleId: string)
	dress(player, roleId)
	tell(player)
	print(("[shifts] %s signed on as %s"):format(player.Name, roleId))
end)

-- ---------------------------------------------------------------- the remote

-- A plain pass-through, the same shape as ClaimSlot: everything that could be
-- wrong -- an unknown shift, one with no depot in this district, a client
-- nowhere near one, a client asking four hundred times a second -- is decided
-- inside RoleService, so there is exactly one place to read.
SignOn.OnServerInvoke = function(player: Player, roleId)
	if type(roleId) ~= "string" or #roleId > 32 then
		return false, "bad request"
	end
	return RoleService.signOn(player, roleId)
end

-- ---------------------------------------------------------------- players

local function onJoin(player: Player)
	-- The car is spawned by VehicleServer on the same event, and which of the two
	-- runs first is not something either script should depend on. Telling the
	-- client its role does not need the car; dressing it does, and the default
	-- shift is the undressed one anyway.
	tell(player)
end

Players.PlayerAdded:Connect(onJoin)
for _, p in Players:GetPlayers() do
	task.spawn(onJoin, p)
end

print(("[shifts] %d sign-on depots on the map"):format(#depots))
