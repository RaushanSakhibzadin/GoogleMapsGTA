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
local RoadMask = require(ReplicatedStorage:WaitForChild("Shared"):WaitForChild("RoadMask"))

local Tarmac = {}

-- ---------------------------------------------------------------- base64

-- Luau has no base64 decoder and the mask ships as base64 because 22,500 cells
-- is 2.8 kB packed against 45 kB as a table of ones and zeros -- and a table
-- that size is parse time on every client, every join.
local B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local LOOKUP: { [number]: number } = {}
for i = 1, #B64 do
	LOOKUP[string.byte(B64, i)] = i - 1
end

local function decodeBase64(s: string): buffer
	-- strip padding; the length is recomputed from the real character count
	local clean = string.gsub(s, "=", "")
	local n = #clean
	local out = buffer.create((n * 6) // 8)
	local acc, bits, at = 0, 0, 0

	for i = 1, n do
		local v = LOOKUP[string.byte(clean, i)]
		if v == nil then
			continue -- newline or stray whitespace
		end
		acc = acc * 64 + v
		bits += 6
		if bits >= 8 then
			bits -= 8
			local byte = (acc // (2 ^ bits)) % 256
			buffer.writeu8(out, at, byte)
			at += 1
			acc %= 2 ^ bits
		end
	end
	return out
end

local BITS = decodeBase64(RoadMask.bits)
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
