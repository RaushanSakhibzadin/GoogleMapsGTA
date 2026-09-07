--!strict
-- The minimap: a hexagon of the district, turning with the car.
--
-- PAINTED, NOT UPLOADED. Roblox cannot ship an image without it being an
-- uploaded asset, which means Open Cloud and a moderation pass for something
-- regenerated every time the district changes. So the bake rasterises the whole
-- district to two bits a pixel -- 64 kB for 512 squared, against 786 kB as RGB
-- -- and this samples out of it into an EditableImage. Same trick as the hex
-- prism mesh, and the same principle as proctex.js: nothing in this project is
-- a file somebody drew.
--
-- AND SAMPLED PER FRAME RATHER THAN SLID ABOUT, which is the decision that
-- makes both of the things asked for possible at once.
--
-- The obvious build is an ImageLabel of the whole district inside a clipping
-- frame, moved so the player is centred -- cheap, and what this did first. But
-- ClipsDescendants is RECTANGULAR and there is no other clip in Roblox, so a
-- hexagonal panel is not expressible that way; and rotating the sheet leaves
-- the corners swinging in and out of a square hole.
--
-- Generating the visible image instead solves both at once and adds a third
-- thing for nothing: the hexagon is just which pixels get an alpha, the
-- rotation is just what the sample offsets are rotated by, and the result is
-- chunky in a way that suits a voxel city.
--
-- THE COST IS THE RESOLUTION, so it is small on purpose: 96 squared is 9,216
-- samples an update at 20 Hz, which is a fifth of what 60 Hz at panel
-- resolution would be. A minimap does not need either.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local AssetService = game:GetService("AssetService")

local player = Players.LocalPlayer
local Shared = ReplicatedStorage:WaitForChild("Shared")
local MapData = require(Shared:WaitForChild("Minimap"))
local Base64 = require(Shared:WaitForChild("Base64"))

local Remotes = ReplicatedStorage:WaitForChild("Remotes")
local Board = Remotes:WaitForChild("IncidentBoard") :: RemoteEvent

local VIEW = 196 -- the panel on screen, in GUI pixels
local RES = 96 -- the image behind it; chunky on purpose
local SPAN = 620 -- studs across the panel: about 200 m of city
local HZ = 20 -- redraws a second

-- Class colours, TAKEN FROM THE CITY'S OWN PALETTE rather than repeated here.
--
-- These used to be a second copy, and the two drifted into exact opposites: the
-- world drew dark asphalt on pale ground and the map drew pale tarmac on dark
-- ground, so the same street was the light thing in one and the dark thing in
-- the other. Reading them out of StreetMeta means they cannot disagree again.
--
-- Unpacked to RGB triples once, because the inner loop writes bytes nine
-- thousand times an update and should not be pulling fields off a Color3.
local StreetMeta = require(Shared.Parent:WaitForChild("CityVisual"):WaitForChild("StreetMeta"))
local function triple(c: Color3): { number }
	return { math.floor(c.R * 255), math.floor(c.G * 255), math.floor(c.B * 255) }
end
local CLASS = {
	[0] = triple(StreetMeta.colours.plain),
	[1] = triple(StreetMeta.colours.park),
	[2] = triple(StreetMeta.colours.kerb),
	[3] = triple(StreetMeta.colours.road),
}

-- ---------------------------------------------------------------- the panel

local gui = Instance.new("ScreenGui")
gui.Name = "Minimap"
gui.ResetOnSpawn = false
gui.IgnoreGuiInset = true
gui.Parent = player:WaitForChild("PlayerGui")

local panel = Instance.new("Frame")
panel.Size = UDim2.fromOffset(VIEW, VIEW)
panel.Position = UDim2.new(1, -VIEW - 18, 0, 18)
panel.BackgroundTransparency = 1
panel.Parent = gui

local sheet = Instance.new("ImageLabel")
sheet.Size = UDim2.fromScale(1, 1)
sheet.BackgroundTransparency = 1
sheet.ScaleType = Enum.ScaleType.Stretch
-- No smoothing: at 96 across a 196 pixel panel the samples ARE the look, and
-- bilinear would turn a crisp hex grid into porridge.
sheet.ResampleMode = Enum.ResamplerMode.Pixelated
sheet.Parent = panel

-- ---------------------------------------------------------------- the source

local SRC = MapData.px
local SRC_BITS = Base64.decode(MapData.bits)
local HALF = MapData.halfStuds
local SRC_PER_STUD = SRC / (HALF * 2)

-- Class at a world position, or 0 outside the district.
local function classAt(x: number, z: number): number
	local i = math.floor((x + HALF) * SRC_PER_STUD)
	local j = math.floor((z + HALF) * SRC_PER_STUD)
	if i < 0 or i >= SRC or j < 0 or j >= SRC then
		return 0
	end
	local at = j * SRC + i
	return (buffer.readu8(SRC_BITS, at // 4) // (2 ^ ((at % 4) * 2))) % 4
end

-- ---------------------------------------------------------------- the hexagon

-- Which output pixels are inside the panel's hexagon, worked out once.
--
-- POINTY-TOP, matching the lattice the city is built on (see
-- tools/roblox/lattice.mjs) -- a flat-top minimap over a pointy-top city reads
-- as a different shape rather than as the same one.
--
-- For circumradius R the hexagon is |x| <= R*sqrt(3)/2 and |y| <= R - |x|/sqrt(3):
-- at x = 0 that is |y| <= R, the top and bottom points, and at the full width it
-- is |y| <= R/2, the flat sides.
local INSIDE = table.create(RES * RES, false)
do
	local c = (RES - 1) / 2
	local R = c
	local w = R * math.sqrt(3) / 2
	for j = 0, RES - 1 do
		for i = 0, RES - 1 do
			local dx, dy = i - c, j - c
			INSIDE[j * RES + i + 1] = math.abs(dx) <= w
				and math.abs(dy) <= R - math.abs(dx) / math.sqrt(3)
		end
	end
end

-- ---------------------------------------------------------------- the image

local image: EditableImage? = nil
local rgba = buffer.create(RES * RES * 4)
do
	local ok, err = pcall(function()
		image = AssetService:CreateEditableImage({ Size = Vector2.new(RES, RES) })
	end)
	if not ok then
		warn("[minimap] EditableImage unavailable (" .. tostring(err) .. ") -- blips only")
		image = nil
	end
end

-- ---------------------------------------------------------------- blips

local function dot(size: number, colour: Color3, z: number): Frame
	local f = Instance.new("Frame")
	f.Size = UDim2.fromOffset(size, size)
	f.AnchorPoint = Vector2.new(0.5, 0.5)
	f.BackgroundColor3 = colour
	f.BorderSizePixel = 0
	f.ZIndex = z
	local c = Instance.new("UICorner")
	c.CornerRadius = UDim.new(1, 0)
	c.Parent = f
	f.Parent = panel
	return f
end

-- The car sits in the middle and always points UP, because the map turns
-- instead. That is the whole difference between a heading-up map and a
-- north-up one, and it is why the arrow needs no rotation of its own.
local me = Instance.new("Frame")
me.Size = UDim2.fromOffset(4, 12)
me.AnchorPoint = Vector2.new(0.5, 0.5)
me.Position = UDim2.fromOffset(VIEW / 2, VIEW / 2)
me.BackgroundColor3 = Color3.fromRGB(255, 255, 255)
me.BorderSizePixel = 0
me.ZIndex = 10
me.Parent = panel
local meCorner = Instance.new("UICorner")
meCorner.CornerRadius = UDim.new(1, 0)
meCorner.Parent = me

local blips: { Frame } = {}
local board: { any } = {}
Board.OnClientEvent:Connect(function(list)
	board = list
end)

-- ---------------------------------------------------------------- the frame

local function carPivot(): CFrame?
	local cars = workspace:FindFirstChild("Cars")
	local model = cars and cars:FindFirstChild("Car_" .. player.UserId)
	if model and model:IsA("Model") then
		return model:GetPivot()
	end
	return nil
end

local STUDS_PER_PX = SPAN / RES
local acc = 1 / HZ

RunService.RenderStepped:Connect(function(dt)
	local pivot = carPivot()
	if not pivot then
		return
	end
	local p = pivot.Position
	local look = pivot.LookVector

	-- The car's own axes on the ground. `right` is look turned a quarter turn
	-- clockwise about Y; `back` is straight behind. Screen +x is right and
	-- screen +y is DOWN, which is behind the car -- so these two are exactly the
	-- basis the output pixels are laid out in, and the map comes out heading-up
	-- with no separate rotation step.
	local lx, lz = look.X, look.Z
	local rx, rz = -lz, lx
	local bx, bz = -lx, -lz

	acc += dt
	if image and acc >= 1 / HZ then
		acc = 0
		local c = (RES - 1) / 2
		local at = 0
		for j = 0, RES - 1 do
			local dy = (j - c) * STUDS_PER_PX
			for i = 0, RES - 1 do
				if INSIDE[j * RES + i + 1] then
					local dx = (i - c) * STUDS_PER_PX
					local wx = p.X + dx * rx + dy * bx
					local wz = p.Z + dx * rz + dy * bz
					local col = CLASS[classAt(wx, wz)]
					buffer.writeu8(rgba, at, col[1])
					buffer.writeu8(rgba, at + 1, col[2])
					buffer.writeu8(rgba, at + 2, col[3])
					buffer.writeu8(rgba, at + 3, 235)
				else
					-- Outside the hexagon is fully transparent, which is what
					-- makes the panel a hexagon at all -- there is no clipping
					-- in Roblox that would do it.
					buffer.writeu8(rgba, at + 3, 0)
				end
				at += 4
			end
		end
		;(image :: EditableImage):WritePixelsBuffer(Vector2.zero, Vector2.new(RES, RES), rgba)
		sheet.ImageContent = Content.fromObject(image :: EditableImage)
	end

	-- Blips, in the same rotated basis as the pixels.
	local n = 0
	local scale = VIEW / SPAN
	for _, inc in board do
		n += 1
		local f = blips[n]
		if not f then
			f = dot(9, Color3.fromRGB(255, 140, 40), 8)
			blips[n] = f
		end
		f.Visible = true
		f.BackgroundColor3 = if inc.filled > 0
			then Color3.fromRGB(120, 200, 150)
			else Color3.fromRGB(255, 140, 40)

		local wx, wz = inc.x - p.X, inc.z - p.Z
		local sx = (wx * rx + wz * rz) * scale
		local sy = (wx * bx + wz * bz) * scale

		-- CLAMPED TO THE HEXAGON'S EDGE rather than hidden, so an incident off
		-- the map still says which way to drive. Scaled down the ray to the
		-- boundary, so it lands on the flat sides as well as the points.
		local R = VIEW / 2 - 7
		local w = R * math.sqrt(3) / 2
		local k = math.max(math.abs(sx) / w, (math.abs(sy) + math.abs(sx) / math.sqrt(3)) / R)
		if k > 1 then
			sx, sy = sx / k, sy / k
		end
		f.Position = UDim2.fromOffset(VIEW / 2 + sx, VIEW / 2 + sy)
	end
	for i = n + 1, #blips do
		blips[i].Visible = false
	end
end)
