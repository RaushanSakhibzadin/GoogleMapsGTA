--!strict
-- IS THERE ROAD UNDER THIS POINT?
--
-- Wraps the baked drivable mask (Shared/RoadMask, one bit a cell at 8 m) in the
-- question the driving model actually asks. Metres in, boolean out -- the model
-- is in metres and this is the only file that knows the mask is in cells.
--
-- THE 8 m CELL IS NOT ARBITRARY. It matches W.cell in the browser game exactly,
-- which is what makes VehicleModel.STRAY_TOL = 10 still mean what it was tuned
-- to mean: a bit over one cell of slack, so a metre of disagreement between the
-- mask and the drawn road is free rather than being a car stopped dead on
-- tarmac.

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("Shared")
local RoadMask = require(Shared:WaitForChild("RoadMask"))
-- The decoder is shared with the minimap, which arrives the same way.
local Base64 = require(Shared:WaitForChild("Base64"))

local Tarmac = {}

local BITS = Base64.decode(RoadMask.bits)
local SPAN = RoadMask.span
local CELL = RoadMask.cellM
local ORIGIN = RoadMask.originM

-- ---------------------------------------------------------------- lookup

local function cellAt(i: number, j: number): boolean
	if i < 0 or i >= SPAN or j < 0 or j >= SPAN then
		return false
	end
	local index = j * SPAN + i
	local byte = buffer.readu8(BITS, index // 8)
	return (byte // (2 ^ (index % 8))) % 2 == 1
end

-- Metres in. Outside the district reads as "no road", which is correct: the
-- baked city has an edge and beyond it there is nothing.
function Tarmac.isRoad(x: number, y: number): boolean
	return cellAt(math.floor((x - ORIGIN) / CELL), math.floor((y - ORIGIN) / CELL))
end

-- WITH THE TOLERANCE APPLIED, and this is what the model should call.
--
-- The browser asks nearestRoadDir() for the distance to the closest tarmac and
-- compares it against STRAY_TOL. There is no nearest-road index in the bake, so
-- this samples the cell under the car and its eight neighbours instead: at an
-- 8 m cell that reaches just past 10 m diagonally, which is the same question
-- to within a metre and costs nine array reads rather than a spatial query.
function Tarmac.nearRoad(x: number, y: number): boolean
	local i = math.floor((x - ORIGIN) / CELL)
	local j = math.floor((y - ORIGIN) / CELL)
	for dj = -1, 1 do
		for di = -1, 1 do
			if cellAt(i + di, j + dj) then
				return true
			end
		end
	end
	return false
end

Tarmac.span = SPAN
Tarmac.cellM = CELL
Tarmac.originM = ORIGIN

return Tarmac
