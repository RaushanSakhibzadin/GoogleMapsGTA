--!strict
-- THE BIG MAP: the whole district, north up, with everything on it.
--
-- Opened by tapping the minimap or pressing M. The minimap answers "which way
-- do I turn at this junction"; this answers "where in Belgrade am I and what
-- else is out there", which are different enough questions to deserve different
-- screens.
--
-- NORTH UP, AND THAT IS DELIBERATELY THE OPPOSITE OF THE MINIMAP. A heading-up
-- map is right when you are reading it a second at a time out of the corner of
-- your eye -- left on the map is left through the windscreen. It is wrong when
-- you are looking at the whole city: a map that rotates has no memory, and the
-- thing a big map is for is building one. So this one is fixed, and the arrow
-- turns instead.
--
-- THE PICTURE IS DECODED ONCE, NOT SAMPLED PER FRAME. The minimap resamples a
-- rotating window out of the raster twenty times a second, which is right for
-- ninety-six pixels and impossible for a million. Here the whole 1024 squared
-- raster becomes one EditableImage on first open, and panning and zooming after
-- that is where an ImageLabel sits inside a clipping frame -- which costs
-- nothing at all.
--
-- BUILT ON FIRST OPEN rather than at join. It is about a second of work and
-- most sessions never open it; joining is already three waits long (§7.5) and
-- this has no business being a fourth.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local UserInputService = game:GetService("UserInputService")

local player = Players.LocalPlayer
local Shared = ReplicatedStorage:WaitForChild("Shared")
local CityVisual = ReplicatedStorage:WaitForChild("CityVisual")

local MapPaint = require(CityVisual:WaitForChild("MapPaint"))
local ClientBus = require(Shared:WaitForChild("ClientBus"))
local Depots = require(Shared:WaitForChild("Depots"))

local Remotes = ReplicatedStorage:WaitForChild("Remotes")
local Board = Remotes:WaitForChild("IncidentBoard") :: RemoteEvent

local INK = Color3.fromRGB(238, 240, 244)
local DIM = Color3.fromRGB(150, 156, 166)
local ACCENT = Color3.fromRGB(255, 140, 40)

local HALF = MapPaint.halfStuds

-- Zoom 1 fits the whole district in the window; 6 is close enough to pick a
-- street out. Beyond that the raster is 2.3 m a pixel and there is nothing more
-- to see.
local ZOOM_MIN, ZOOM_MAX = 1, 6

-- ---------------------------------------------------------------- the screen

local gui = Instance.new("ScreenGui")
gui.Name = "BigMap"
gui.ResetOnSpawn = false
gui.IgnoreGuiInset = true
gui.DisplayOrder = 60 -- over the dispatch card and the settings gear
gui.Enabled = false
gui.Parent = player:WaitForChild("PlayerGui")

local dim = Instance.new("Frame")
dim.Size = UDim2.fromScale(1, 1)
dim.BackgroundColor3 = Color3.fromRGB(6, 7, 9)
dim.BackgroundTransparency = 0.25
dim.BorderSizePixel = 0
dim.Parent = gui

-- THE WINDOW IS SQUARE AND FITS THE SHORT SIDE, because the district is square
-- and a square map in a rectangular hole either stretches or leaves a margin
-- that looks like a mistake. Scale on both axes with AspectRatio doing the
-- work, so it follows a resize with no code.
local window = Instance.new("Frame")
window.Size = UDim2.fromScale(0.86, 0.86)
window.Position = UDim2.fromScale(0.5, 0.5)
window.AnchorPoint = Vector2.new(0.5, 0.5)
window.BackgroundColor3 = Color3.fromRGB(12, 13, 16)
window.BorderSizePixel = 0
window.ClipsDescendants = true
window.Parent = gui
local ratio = Instance.new("UIAspectRatioConstraint")
ratio.AspectRatio = 1
ratio.Parent = window
local wCorner = Instance.new("UICorner")
wCorner.CornerRadius = UDim.new(0, 8)
wCorner.Parent = window

local sheet = Instance.new("ImageLabel")
sheet.BackgroundTransparency = 1
sheet.ScaleType = Enum.ScaleType.Stretch
sheet.ResampleMode = Enum.ResamplerMode.Pixelated
sheet.Size = UDim2.fromScale(1, 1)
sheet.Position = UDim2.fromScale(0, 0)
sheet.Parent = window

-- Markers live above the sheet and inside the window, so they are clipped by it
-- exactly as the map is.
local marks = Instance.new("Frame")
marks.Size = UDim2.fromScale(1, 1)
marks.BackgroundTransparency = 1
marks.ZIndex = 5 -- over the map and the drag pad, under the chrome
marks.Parent = window

local function text(parent: Instance, pos: UDim2, size: UDim2, str: string, sz: number, colour: Color3, font: Enum.Font): TextLabel
	local t = Instance.new("TextLabel")
	t.BackgroundTransparency = 1
	t.Position = pos
	t.Size = size
	t.Text = str
	t.TextSize = sz
	t.TextColor3 = colour
	t.Font = font
	t.TextXAlignment = Enum.TextXAlignment.Left
	t.Parent = parent
	return t
end

-- ALL THE CHROME LIVES INSIDE THE WINDOW, and that is not a style choice. With
-- IgnoreGuiInset the screen starts at y = 0, where Roblox's own menu and chat
-- buttons are -- and the title, sitting just above the map, landed underneath
-- them. Anything anchored to the window cannot collide with the platform's UI,
-- and it cannot land on top of the dispatch card in the other corner either.
--
-- ZIndex 20 puts the whole lot over the map and over the markers, so a button
-- is never fighting a blip for the same click.
local chrome = Instance.new("Frame")
chrome.Size = UDim2.fromScale(1, 1)
chrome.BackgroundTransparency = 1
chrome.ZIndex = 20
chrome.Parent = window

local function pill(pos: UDim2, size: UDim2): Frame
	local f = Instance.new("Frame")
	f.Position = pos
	f.Size = size
	f.BackgroundColor3 = Color3.fromRGB(10, 11, 14)
	f.BackgroundTransparency = 0.25
	f.BorderSizePixel = 0
	f.ZIndex = 20
	local c = Instance.new("UICorner")
	c.CornerRadius = UDim.new(0, 6)
	c.Parent = f
	f.Parent = chrome
	return f
end

local titleBar = pill(UDim2.fromOffset(10, 10), UDim2.fromOffset(232, 30))
local title = text(titleBar, UDim2.fromOffset(12, 0), UDim2.new(1, -12, 1, 0), "PALILULA  ·  BEOGRAD", 14, ACCENT, Enum.Font.GothamMedium)
title.ZIndex = 21

-- NARROWED ON THE RIGHT so the button column below has its own lane: at full
-- width the bar ran underneath the ME button.
local hintBar = pill(UDim2.new(0, 10, 1, -40), UDim2.new(1, -74, 0, 30))
local hint = text(hintBar, UDim2.fromOffset(12, 0), UDim2.new(1, -12, 1, 0), "", 13, DIM, Enum.Font.Gotham)
hint.ZIndex = 21

local close = Instance.new("TextButton")
close.Size = UDim2.fromOffset(30, 30)
close.Position = UDim2.new(1, -40, 0, 10)
close.BackgroundColor3 = Color3.fromRGB(10, 11, 14)
close.BackgroundTransparency = 0.25
close.BorderSizePixel = 0
close.Text = "X"
close.TextSize = 16
close.TextColor3 = DIM
close.Font = Enum.Font.GothamMedium
close.ZIndex = 21
close.Parent = chrome
local cc = Instance.new("UICorner")
cc.CornerRadius = UDim.new(0, 6)
cc.Parent = close

-- THE ZOOM BUTTONS, asked for by name. Scroll and pinch both work too, but a
-- button is the one control that needs no mouse and no explanation -- and on a
-- touch screen it is the only one of the three that exists.
local function chromeButton(order: number, label: string, size: number): TextButton
	local b = Instance.new("TextButton")
	b.Size = UDim2.fromOffset(34, 34)
	b.Position = UDim2.new(1, -44, 1, -50 - order * 40)
	b.BackgroundColor3 = Color3.fromRGB(10, 11, 14)
	b.BackgroundTransparency = 0.25
	b.BorderSizePixel = 0
	b.Text = label
	b.TextSize = size
	b.TextColor3 = INK
	b.Font = Enum.Font.GothamMedium
	b.ZIndex = 21
	b.Parent = chrome
	local c = Instance.new("UICorner")
	c.CornerRadius = UDim.new(0, 6)
	c.Parent = b
	return b
end

local zoomIn = chromeButton(2, "+", 22)
local zoomOut = chromeButton(1, "-", 22)
local locate = chromeButton(0, "ME", 12)

-- ---------------------------------------------------------------- markers

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
	f.Parent = marks
	return f
end

-- The car. A triangle would be better and Roblox has no triangle in a GUI, so
-- it is a short bar that rotates -- which reads as a heading at this size, and
-- is the same compromise the minimap's arrow makes.
local me = Instance.new("Frame")
me.Size = UDim2.fromOffset(5, 15)
me.AnchorPoint = Vector2.new(0.5, 0.5)
me.BackgroundColor3 = Color3.fromRGB(255, 255, 255)
me.BorderSizePixel = 0
me.ZIndex = 12
me.Parent = marks
local meCorner = Instance.new("UICorner")
meCorner.CornerRadius = UDim.new(1, 0)
meCorner.Parent = me

-- DEPOTS ARE STATIC, so they are made once. This is the district's answer to
-- "where do I sign on" -- and at 2.4 km it finally has one worth showing: ten
-- of them, including two police and a fire station.
local DEPOT_COLOUR: { [string]: Color3 } = {
	fire = Color3.fromRGB(226, 72, 56),
	police = Color3.fromRGB(96, 152, 230),
	repair = Color3.fromRGB(150, 156, 166),
	hospital = Color3.fromRGB(240, 240, 244),
}
local depotDots: { { f: Frame, x: number, z: number } } = {}
for _, d in Depots :: { any } do
	local f = dot(8, DEPOT_COLOUR[d.kind] or DIM, 6)
	f.BackgroundTransparency = 0.15
	table.insert(depotDots, { f = f, x = d.x, z = d.z })
end

local blips: { Frame } = {}
local board: { any } = {}
Board.OnClientEvent:Connect(function(list)
	board = list
end)

-- ---------------------------------------------------------------- the view

-- `zoom` is how many district-widths fit across the window; `cx, cz` is the
-- world point at the middle of it, in studs.
local zoom = 1
local cx, cz = 0, 0

local function carPivot(): CFrame?
	local cars = workspace:FindFirstChild("Cars")
	local model = cars and cars:FindFirstChild("Car_" .. player.UserId)
	if model and model:IsA("Model") then
		return model:GetPivot()
	end
	return nil
end

-- CLAMPED SO THE DISTRICT ALWAYS FILLS THE WINDOW. Without this you can pan the
-- city off the edge and be left looking at an empty rectangle wondering what
-- broke. At zoom 1 the only legal centre is the middle, which the arithmetic
-- gives for free: the half-span equals HALF, so the range collapses to zero.
local function clampCentre()
	local halfSpan = HALF / zoom
	local limit = HALF - halfSpan
	cx = math.clamp(cx, -limit, limit)
	cz = math.clamp(cz, -limit, limit)
end

-- The sheet is the whole raster, so showing 1/zoom of it means being `zoom`
-- times the window and offset so that (cx, cz) lands in the middle.
local function layout()
	clampCentre()
	sheet.Size = UDim2.fromScale(zoom, zoom)
	-- Where the centre is as a fraction of the district, 0..1
	local u = (cx + HALF) / (HALF * 2)
	local v = (cz + HALF) / (HALF * 2)
	sheet.Position = UDim2.fromScale(0.5 - u * zoom, 0.5 - v * zoom)
end

-- World studs to a position inside the window, 0..1 on each axis.
local function project(x: number, z: number): (number, number)
	local halfSpan = HALF / zoom
	return 0.5 + (x - cx) / (halfSpan * 2), 0.5 + (z - cz) / (halfSpan * 2)
end

local function place(f: Frame, x: number, z: number): boolean
	local u, v = project(x, z)
	-- A marker well outside the window is hidden rather than drawn at a huge
	-- offset: Roblox will happily lay out a frame ten thousand pixels away and
	-- pay for it every frame.
	if u < -0.1 or u > 1.1 or v < -0.1 or v > 1.1 then
		f.Visible = false
		return false
	end
	f.Visible = true
	f.Position = UDim2.fromScale(u, v)
	return true
end

-- ---------------------------------------------------------------- the sheet

local built = false
local building = false
local noImage = false

local function ensureSheet()
	if built or building then
		return
	end
	building = true
	task.spawn(function()
		local image = MapPaint.sheet(4 / 1000, function()
			RunService.Heartbeat:Wait()
		end)
		if image then
			sheet.ImageContent = Content.fromObject(image)
			built = true
		else
			-- No EditableImage on this client. The markers still work, so the map
			-- is a diagram rather than nothing -- which is a good deal more
			-- useful than an error.
			window.BackgroundColor3 = Color3.fromRGB(18, 20, 24)
			-- LATCHED, not written once. The hint line is rewritten every frame
			-- further down, so a message set here would have survived exactly one
			-- of them.
			noImage = true
		end
		building = false
	end)
end

-- ---------------------------------------------------------------- open, shut

local open = false

local function setOpen(v: boolean)
	open = v
	gui.Enabled = v
	if v then
		ensureSheet()
		-- OPENS ON THE WHOLE DISTRICT. It used to open at 3x centred on the car,
		-- on the reasoning that "where am I" is the first question -- but the
		-- arrow answers that at any zoom, and opening zoomed in means the first
		-- thing you do every single time is zoom out to see what you are looking
		-- at. A map that opens on the city and has a ME button is the better way
		-- round.
		zoom = ZOOM_MIN
		cx, cz = 0, 0
		layout()
	end
end

ClientBus.toggleMap.Event:Connect(function()
	setOpen(not open)
end)
close.Activated:Connect(function()
	setOpen(false)
end)

-- MULTIPLICATIVE, like the wheel, so a press is the same proportion at every
-- zoom. A fixed step is glacial at 1x and violent at 6x.
local function stepZoom(by: number)
	zoom = math.clamp(zoom * by, ZOOM_MIN, ZOOM_MAX)
	layout()
end
zoomIn.Activated:Connect(function()
	stepZoom(1.5)
end)
zoomOut.Activated:Connect(function()
	stepZoom(1 / 1.5)
end)

-- ME: put the car in the middle, and go in far enough to see the street it is
-- on if the map is still showing the whole district.
locate.Activated:Connect(function()
	local pivot = carPivot()
	if pivot then
		cx, cz = pivot.Position.X, pivot.Position.Z
		if zoom < 2.5 then
			zoom = 3
		end
		layout()
	end
end)

UserInputService.InputBegan:Connect(function(input, processed)
	if processed then
		return
	end
	if input.KeyCode == Enum.KeyCode.M then
		setOpen(not open)
	elseif open and input.KeyCode == Enum.KeyCode.Backspace then
		setOpen(false)
	end
end)

-- ---------------------------------------------------------------- pan, zoom

-- Dragging pans. The delta is in pixels and has to become studs, which is the
-- window's span divided by its size -- so the map moves exactly with the
-- pointer at any zoom, which is the only thing that feels right.
local dragging = false
local lastX, lastY = 0, 0

-- THE DRAG TARGET IS A BUTTON, NOT THE FRAME.
--
-- A Frame only receives InputBegan when it is Active, and whether it does at all
-- through a stack of other GuiObjects is exactly the kind of thing this project
-- cannot test. A TextButton filling the window is unambiguous: buttons take
-- input, that is what they are.
--
-- It sits ABOVE the map and BELOW the chrome (ZIndex 2 against 20), so the zoom
-- and close buttons get their clicks first and everything else is a drag. The
-- markers are plain Frames, so they do not take input and cannot swallow one.
local dragPad = Instance.new("TextButton")
dragPad.Size = UDim2.fromScale(1, 1)
dragPad.BackgroundTransparency = 1
dragPad.Text = ""
dragPad.AutoButtonColor = false
dragPad.ZIndex = 2
dragPad.Parent = window

dragPad.InputBegan:Connect(function(input)
	if
		input.UserInputType == Enum.UserInputType.MouseButton1
		or input.UserInputType == Enum.UserInputType.Touch
	then
		dragging = true
		lastX, lastY = input.Position.X, input.Position.Y
	end
end)

UserInputService.InputChanged:Connect(function(input)
	if not open then
		return
	end
	if
		dragging
		and (
			input.UserInputType == Enum.UserInputType.MouseMovement
			or input.UserInputType == Enum.UserInputType.Touch
		)
	then
		local px = window.AbsoluteSize.X
		if px > 0 then
			local studsPerPixel = (HALF * 2 / zoom) / px
			cx -= (input.Position.X - lastX) * studsPerPixel
			cz -= (input.Position.Y - lastY) * studsPerPixel
			lastX, lastY = input.Position.X, input.Position.Y
			layout()
		end
	elseif input.UserInputType == Enum.UserInputType.MouseWheel then
		-- Multiplicative, so each notch is the same proportion whatever the zoom
		-- -- a fixed step is glacial at 1 and violent at 6.
		zoom = math.clamp(zoom * (if input.Position.Z > 0 then 1.25 else 0.8), ZOOM_MIN, ZOOM_MAX)
		layout()
	end
end)

UserInputService.InputEnded:Connect(function(input)
	if
		input.UserInputType == Enum.UserInputType.MouseButton1
		or input.UserInputType == Enum.UserInputType.Touch
	then
		dragging = false
	end
end)

-- ---------------------------------------------------------------- the frame

-- ONLY WHILE IT IS OPEN. A full-screen map that is not on screen should cost
-- exactly nothing, and this is the one piece of UI in the game that is closed
-- most of the time.
RunService.RenderStepped:Connect(function()
	if not open then
		return
	end

	local pivot = carPivot()
	if pivot then
		local p = pivot.Position
		if place(me, p.X, p.Z) then
			-- The map is north-up, so the arrow carries the heading. Roblox
			-- rotates a GuiObject clockwise in degrees; the car's look vector is
			-- in world X/Z, and atan2(x, -z) is the bearing from north.
			local look = pivot.LookVector
			me.Rotation = math.deg(math.atan2(look.X, -look.Z))
		end
	else
		me.Visible = false
	end

	for _, d in depotDots do
		place(d.f, d.x, d.z)
	end

	local n = 0
	for _, inc in board do
		n += 1
		local f = blips[n]
		if not f then
			f = dot(11, ACCENT, 10)
			blips[n] = f
		end
		f.BackgroundColor3 = if inc.filled > 0 then Color3.fromRGB(120, 200, 150) else ACCENT
		place(f, inc.x, inc.z)
	end
	for i = n + 1, #blips do
		blips[i].Visible = false
	end

	if noImage then
		hint.Text = "Map image unavailable on this client -- markers only"
	else
		hint.Text = ("drag to pan  ·  + and - to zoom (%.1fx)  ·  ME centres on you  ·  %d jobs  ·  M or X closes")
			:format(zoom, n)
	end
end)
