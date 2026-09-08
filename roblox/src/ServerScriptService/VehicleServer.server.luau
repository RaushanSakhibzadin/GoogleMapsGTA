--!strict
-- Cars: who has one, where it is, and whether that is plausible.
--
-- THE AUTHORITY SPLIT, from ROBLOX_PORT_PLAN.md §4.1. The driver's own client
-- integrates the driving model and reports where it ended up; the server checks
-- that the report is possible and replicates it to everyone else. That is a
-- disagreement with "server-authoritative" as usually meant, and it is
-- deliberate: Roblox has no rollback netcode, so simulating the car here would
-- give the driver a full round trip of steering lag -- 60 to 120 ms, which is
-- the difference between a good driving game and an unshippable one.
--
-- What the server IS authoritative over is everything that can be exploited for
-- reward: incident claims, money, arrests, the service record. None of that
-- exists yet. What exists now is the position check below, which is what stops
-- a client teleporting across the district later when there is a fare to race
-- another player to.
--
-- NO CHARACTERS. The design says the player is always in a vehicle, so
-- CharacterAutoLoads is off -- no animation, no ragdoll rigs, no on-foot state
-- to write. It is the cheapest simplification in the whole project.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Remotes = ReplicatedStorage:WaitForChild("Remotes")
local CarState = Remotes:WaitForChild("CarState") :: RemoteEvent
local CarCorrection = Remotes:WaitForChild("CarCorrection") :: RemoteEvent

local CarBuild = require(ReplicatedStorage:WaitForChild("Shared"):WaitForChild("CarBuild"))
local VehicleModel = require(ReplicatedStorage:WaitForChild("Shared"):WaitForChild("VehicleModel"))

Players.CharacterAutoLoads = false

local cars = Instance.new("Folder")
cars.Name = "Cars"
cars.Parent = workspace

-- A LITTLE OVER THE TOP SPEED, not exactly it. The client integrates at its own
-- frame rate and reports on a slower timer, so a report legitimately covers more
-- than one step; and a downhill or a shunt can briefly exceed the clamp. 1.3x
-- rejects a teleport and passes everything a real car can do.
local MAX_SPEED = VehicleModel.TOP_SPEED * 1.3

-- WHERE A PLAYER'S CAR GOES, and it has to be a road.
--
-- The district centre is just a coordinate; at Palilula it lands inside a block
-- of flats, and a car that starts inside a building is a car that starts stuck.
-- So the drivable mask is searched outwards from the origin for the nearest
-- cell that is actually tarmac. It is the same question the browser answers
-- with nearestRoadPoint() before every respawn.
local Tarmac = require(ReplicatedStorage:WaitForChild("Shared"):WaitForChild("Tarmac"))

local function findSpawn(): { x: number, y: number, h: number }
	if Tarmac.isRoad(0, 0) then
		return { x = 0, y = 0, h = 0 }
	end
	local step = Tarmac.cellM
	for ring = 1, Tarmac.span do
		for a = 0, 7 do
			local ang = a * math.pi / 4
			local x = math.cos(ang) * ring * step
			local y = math.sin(ang) * ring * step
			if Tarmac.isRoad(x, y) then
				-- pointed back towards the middle of the district, which is at
				-- worst along the street and at best down it
				return { x = x, y = y, h = math.atan2(-y, -x) }
			end
		end
	end
	warn("[cars] no drivable cell found anywhere in the district")
	return { x = 0, y = 0, h = 0 }
end

local SPAWN = findSpawn()
print(("[cars] spawn at %.0f, %.0f m"):format(SPAWN.x, SPAWN.y))

local state: { [Player]: { model: Model, x: number, y: number, h: number, t: number } } = {}

local PALETTE = {
	Color3.fromRGB(214, 78, 92),
	Color3.fromRGB(70, 132, 196),
	Color3.fromRGB(226, 186, 74),
	Color3.fromRGB(96, 176, 116),
	Color3.fromRGB(222, 222, 226),
	Color3.fromRGB(140, 106, 188),
}

local function spawnCar(player: Player)
	local own = PALETTE[(player.UserId % #PALETTE) + 1]
	local model = CarBuild.new(own)
	model.Name = "Car_" .. player.UserId
	model:SetAttribute("Owner", player.UserId)
	-- THE PAINT THIS PLAYER ARRIVED IN, kept because a shift takes it away and
	-- signing off has to give it back. Without it, clocking off a police shift
	-- leaves you in a white car for ever -- the same bug the browser avoids by
	-- keeping `P.car.stock` for the body.
	model:SetAttribute("OwnColour", own)
	model:SetAttribute("Role", "courier")

	-- NEVER STREAMED OUT. With StreamingEnabled a server-made model comes and
	-- goes with the replication focus, and a car can be several things at once:
	-- the thing the focus is anchored TO, the thing another player is chasing,
	-- and the thing that must exist for VehicleController to have anything to
	-- drive. Persistent takes it out of that system entirely, which for a
	-- handful of cars costs nothing.
	--
	-- PCALLED because ModelStreamingMode is a newer property than this project
	-- assumes anywhere else, and a missing one must not stop a car existing.
	pcall(function()
		model.ModelStreamingMode = Enum.ModelStreamingMode.Persistent
	end)
	CarBuild.place(model, SPAWN.x, SPAWN.y, SPAWN.h)
	model.Parent = cars

	state[player] = { model = model, x = SPAWN.x, y = SPAWN.y, h = SPAWN.h, t = os.clock() }

	-- THE REPLICATION FOCUS, WHICH IS NOT OPTIONAL HERE.
	--
	-- Workspace.StreamingEnabled is on, so the server only replicates instances
	-- near each player's focus -- and with CharacterAutoLoads off there IS no
	-- character for Roblox to use as one. Without this the focus never leaves
	-- the world origin, which breaks two things at once:
	--
	--   · the CAR ITSELF. It is a server-made model, so it is streamed like
	--     anything else; reported as "when the loading finishes, the car is
	--     still invisible".
	--   · every COLLISION BOX more than the streaming radius from the origin.
	--     That one had not been noticed yet because it only bites once you have
	--     driven half a kilometre -- at which point the city stops being solid
	--     and you drive through the buildings you can see.
	--
	-- Pointed at the car's own body, which the server moves on every accepted
	-- position report, so the focus follows the player exactly as a character
	-- would have. The client-built scenery is unaffected either way: Roblox does
	-- not stream what a LocalScript makes (see CityVisuals).
	player.ReplicationFocus = model.PrimaryPart

	CarCorrection:FireClient(player, SPAWN.x, SPAWN.y, SPAWN.h)
end

Players.PlayerAdded:Connect(spawnCar)
for _, p in Players:GetPlayers() do
	spawnCar(p)
end

Players.PlayerRemoving:Connect(function(player)
	local s = state[player]
	if s then
		s.model:Destroy()
		state[player] = nil
	end
end)

CarState.OnServerEvent:Connect(function(player, x, y, h)
	local s = state[player]
	if not s then
		return
	end
	-- Anything a client sends is suspect, including its type. A NaN here would
	-- propagate into every other client's CFrame and there is no recovering a
	-- NaN position once it has replicated.
	if
		type(x) ~= "number"
		or type(y) ~= "number"
		or type(h) ~= "number"
		or x ~= x
		or y ~= y
		or h ~= h
	then
		return
	end

	local now = os.clock()
	local dt = math.max(now - s.t, 1 / 60)
	local moved = math.sqrt((x - s.x) ^ 2 + (y - s.y) ^ 2)

	if moved / dt > MAX_SPEED then
		-- Not possible. Keep the last good position and tell the client to go
		-- back to it, rather than accepting and trying to unwind later.
		CarCorrection:FireClient(player, s.x, s.y, s.h)
		return
	end

	s.x, s.y, s.h, s.t = x, y, h, now
	CarBuild.place(s.model, x, y, h)
end)
