--!strict
-- The minimap: the district as a picture, with the fire on it.
--
-- Asked for as "it is hard to find the fire without it", which is the right
-- reason to build one -- an incident beam you can only see when nothing is in
-- the way is not navigation.
--
-- PAINTED, NOT UPLOADED. Roblox cannot ship an image without it being an
-- uploaded asset, which means the Open Cloud pipeline and a moderation pass for
-- something that is regenerated every time the district changes. So the bake
-- rasterises the district to two bits a pixel (64 kB for 512 squared) and this
-- paints it into an EditableImage once, at join. Same trick as the hex prism
-- mesh, and the same thing proctex.js does in the browser: nothing in this
-- project is a file somebody drew.
--
-- NORTH IS UP and the map does not rotate. A rotating map is what the browser
-- does and it is better once you know a city, but it is worse while you are
-- learning one -- and the whole point of this is that the city is unfamiliar.
-- The player arrow rotates instead.
--
-- AND THERE IS A FALLBACK. If EditableImage is unavailable the panel still
-- draws the blips over a plain ground colour: no streets, but the fire is still
-- findable, which is the thing that was actually asked for.

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

local VIEW = 190 -- the panel, in GUI pixels
local SPAN = 620 -- studs across the panel; about 200 m of city

-- Class colours. Road darker than pavement, as on the ground.
local CLASS = {
	[0] = Color3.fromRGB(52, 56, 62),
	[1] = Color3.fromRGB(60, 92, 58),
	[2] = Color3.fromRGB(92, 96, 104),
	[3] = Color3.fromRGB(150, 156, 168),
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
panel.BackgroundColor3 = CLASS[0]
panel.BorderSizePixel = 0
panel.ClipsDescendants = true
panel.Parent = gui
local round = Instance.new("UICorner")
round.CornerRadius = UDim.new(0, 8)
round.Parent = panel

local sheet = Instance.new("ImageLabel")
sheet.BackgroundTransparency = 1
sheet.ScaleType = Enum.ScaleType.Stretch
-- How big the whole district is, in GUI pixels, so that SPAN studs fill VIEW.
local SHEET = (MapData.halfStuds * 2) / SPAN * VIEW
sheet.Size = UDim2.fromOffset(SHEET, SHEET)
sheet.Parent = panel

-- ---------------------------------------------------------------- painting

local painted = false
do
	local ok, err = pcall(function()
		local px = MapData.px
		local bits = Base64.decode(MapData.bits)
		local rgba = buffer.create(px * px * 4)

		for i = 0, px * px - 1 do
			-- two bits a pixel, four to a byte, low pair first
			local byte = buffer.readu8(bits, i // 4)
			local cls = (byte // (2 ^ ((i % 4) * 2))) % 4
			local c = CLASS[cls]
			local at = i * 4
			buffer.writeu8(rgba, at, math.floor(c.R * 255))
			buffer.writeu8(rgba, at + 1, math.floor(c.G * 255))
			buffer.writeu8(rgba, at + 2, math.floor(c.B * 255))
			buffer.writeu8(rgba, at + 3, 255)
		end

		local img = AssetService:CreateEditableImage({ Size = Vector2.new(px, px) })
		img:WritePixelsBuffer(Vector2.zero, Vector2.new(px, px), rgba)
		sheet.ImageContent = Content.fromObject(img)
	end)
	painted = ok
	if not ok then
		warn("[minimap] EditableImage unavailable (" .. tostring(err) .. ") -- blips only")
		sheet.Visible = false
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

local me = Instance.new("ImageLabel")
me.Size = UDim2.fromOffset(14, 14)
me.AnchorPoint = Vector2.new(0.5, 0.5)
me.Position = UDim2.fromOffset(VIEW / 2, VIEW / 2)
me.BackgroundTransparency = 1
me.Image = "rbxasset://textures/ui/Controls/DirectionalIndicator.png"
me.ImageColor3 = Color3.fromRGB(255, 255, 255)
me.ZIndex = 10
me.Parent = panel

-- A pool, so a board that changes size does not churn instances every frame.
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

RunService.RenderStepped:Connect(function()
	local pivot = carPivot()
	if not pivot then
		return
	end
	local p = pivot.Position
	local half = MapData.halfStuds

	-- Slide the sheet so the player sits in the middle of the panel.
	if painted then
		local fx = (p.X + half) / (half * 2)
		local fz = (p.Z + half) / (half * 2)
		sheet.Position = UDim2.fromOffset(VIEW / 2 - fx * SHEET, VIEW / 2 - fz * SHEET)
	end

	-- The arrow points where the car does. The model's nose is -Z, so its look
	-- vector gives the heading directly; atan2 on (X, -Z) puts north at zero and
	-- turns clockwise, which is what a rotation in GUI space wants.
	local look = pivot.LookVector
	me.Rotation = math.deg(math.atan2(look.X, -look.Z))

	local n = 0
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
		-- Clamped to the panel edge rather than hidden, so an incident off the
		-- map still tells you which way to drive.
		local dx = (inc.x - p.X) / SPAN * VIEW
		local dz = (inc.z - p.Z) / SPAN * VIEW
		local edge = VIEW / 2 - 8
		local m = math.max(math.abs(dx), math.abs(dz))
		if m > edge then
			dx, dz = dx / m * edge, dz / m * edge
		end
		f.Position = UDim2.fromOffset(VIEW / 2 + dx, VIEW / 2 + dz)
	end
	for i = n + 1, #blips do
		blips[i].Visible = false
	end
end)
