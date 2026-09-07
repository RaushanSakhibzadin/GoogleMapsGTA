--!strict
-- WHERE THE PLAYER'S CAR IS, for the other things on the same client.
--
-- VehicleController owns the car -- it integrates it, it collides it against
-- buildings, it decides where it is. The traffic and the pedestrians need to
-- read that, and the traffic needs to WRITE to it, because a bus that cannot
-- shunt you is a bus you drive through.
--
-- A ModuleScript is required once per client and its table is shared by every
-- script on that client, so this is the whole mechanism: the controller puts
-- the car in, the life scripts take it out, and nothing has to be copied or
-- sent. It is deliberately not a RemoteEvent or an attribute -- both would be a
-- copy, and a copy cannot be pushed back into.
--
-- NOT AUTHORITY. The server has its own view of where this car is and rejects
-- what it does not believe (see CarState and CarCorrection); this is the local
-- simulation talking to itself.

local VehicleModel = require(script.Parent:WaitForChild("VehicleModel"))

local PlayerCar = {}

PlayerCar.car = nil :: VehicleModel.Car?

function PlayerCar.set(c: VehicleModel.Car)
	PlayerCar.car = c
end

function PlayerCar.get(): VehicleModel.Car?
	return PlayerCar.car
end

-- The player's mass, from makeCar's player branch in js/entities.js: three
-- times an ordinary car, which is what stops a hatchback bouncing you off your
-- own line every time one clips you.
PlayerCar.MASS = 3

return PlayerCar
