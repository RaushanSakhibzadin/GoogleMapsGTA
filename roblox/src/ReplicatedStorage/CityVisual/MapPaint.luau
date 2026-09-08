--!strict
-- THE BAKED MAP OF THE DISTRICT, and the two questions anything drawing it asks.
--
-- Shared by the minimap and the big map, because they are the same picture at
-- two scales and the alternative is two copies of the decode, two copies of the
-- palette and two chances for them to disagree. That has already happened once
-- in this project -- the world and the minimap ran opposite ground palettes and
-- the same street was the light thing in one and the dark thing in the other --
-- and one module is the fix for the class of problem rather than the instance.
--
-- PAINTED, NOT UPLOADED. Roblox cannot ship an image without it being an
-- uploaded asset, which means Open Cloud and a moderation pass for something
-- regenerated every time the district changes. So the bake rasterises the whole
-- district to TWO BITS A PIXEL -- 256 kB for 1024 squared, against 3 MB as RGB
-- -- and anything that wants to look at it decodes out of that.

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local MapData = require(Shared:WaitForChild("Minimap"))
local Base64 = require(Shared:WaitForChild("Base64"))
local StreetMeta = require(script.Parent:WaitForChild("StreetMeta"))

local MapPaint = {}

-- ---------------------------------------------------------------- the source

MapPaint.px = MapData.px :: number -- pixels across the raster
MapPaint.halfStuds = MapData.halfStuds :: number -- half the district, in studs
MapPaint.bits = Base64.decode(MapData.bits)

local SRC = MapPaint.px
local HALF = MapPaint.halfStuds
local BITS = MapPaint.bits
local SRC_PER_STUD = SRC / (HALF * 2)

-- ---------------------------------------------------------------- the palette

-- TAKEN FROM THE CITY'S OWN, not repeated. Unpacked to RGB triples once,
-- because the inner loops here write bytes hundreds of thousands of times and
-- should not be pulling fields off a Color3 to do it.
local function triple(c: Color3): { number }
	return { math.floor(c.R * 255), math.floor(c.G * 255), math.floor(c.B * 255) }
end

MapPaint.CLASS = {
	[0] = triple(StreetMeta.colours.plain),
	[1] = triple(StreetMeta.colours.park),
	[2] = triple(StreetMeta.colours.kerb),
	[3] = triple(StreetMeta.colours.road),
}

-- ---------------------------------------------------------------- lookups

-- The class at a raster pixel. No bounds check: the callers below do it, and
-- this is the hottest line in both maps.
function MapPaint.classAtPixel(i: number, j: number): number
	local at = j * SRC + i
	return (buffer.readu8(BITS, at // 4) // (2 ^ ((at % 4) * 2))) % 4
end

-- The class at a world position in STUDS, or 0 (plain) outside the district.
--
-- The pixel read is INLINED rather than calling classAtPixel, which looks like
-- a duplication and is not: the minimap calls this nine thousand times an
-- update, and at that rate the difference between one call and two is worth
-- more than the two lines it saves.
function MapPaint.classAt(x: number, z: number): number
	local i = math.floor((x + HALF) * SRC_PER_STUD)
	local j = math.floor((z + HALF) * SRC_PER_STUD)
	if i < 0 or i >= SRC or j < 0 or j >= SRC then
		return 0
	end
	local at = j * SRC + i
	return (buffer.readu8(BITS, at // 4) // (2 ^ ((at % 4) * 2))) % 4
end

-- ---------------------------------------------------------------- the sheet

-- THE WHOLE DISTRICT AS ONE IMAGE, decoded once and kept.
--
-- The minimap samples a window out of the raster every update, because the
-- window moves and rotates. The big map does not: it is the whole thing, north
-- up, and panning and zooming it is a matter of where an ImageLabel sits inside
-- a clipping frame. So it is worth paying once to decode the lot and then never
-- touching it again -- a million pixels is far too many to redraw on a pan.
--
-- ONE TO ONE with the raster, so there is no resampling and no decision about
-- what resolution to draw at: the bake already made that decision.
--
-- `budget` is seconds per slice before yielding; pass a yield function to stay
-- off the frame. Returns nil if EditableImage is unavailable, which is a real
-- possibility -- it is behind a beta flag on some clients -- and every caller
-- has to cope.
function MapPaint.sheet(budget: number, yieldFn: (() -> ())?): EditableImage?
	local AssetService = game:GetService("AssetService")
	local image: EditableImage? = nil
	local ok, err = pcall(function()
		image = AssetService:CreateEditableImage({ Size = Vector2.new(SRC, SRC) })
	end)
	if not ok or not image then
		warn("[map] EditableImage unavailable (" .. tostring(err) .. ") -- no big map")
		return nil
	end

	local rgba = buffer.create(SRC * SRC * 4)
	local at = 0
	local t0 = os.clock()
	for j = 0, SRC - 1 do
		for i = 0, SRC - 1 do
			local col = MapPaint.CLASS[MapPaint.classAtPixel(i, j)]
			buffer.writeu8(rgba, at, col[1])
			buffer.writeu8(rgba, at + 1, col[2])
			buffer.writeu8(rgba, at + 2, col[3])
			buffer.writeu8(rgba, at + 3, 255)
			at += 4
		end
		-- A ROW AT A TIME, not a pixel: the clock read is the expensive part of
		-- a budget check and a row is a thousand pixels of work between them.
		if yieldFn and os.clock() - t0 > budget then
			yieldFn()
			t0 = os.clock()
		end
	end

	;(image :: EditableImage):WritePixelsBuffer(Vector2.zero, Vector2.new(SRC, SRC), rgba)
	return image
end

return MapPaint
