--!strict
-- SETTINGS: the sound mixer, and somewhere for the next setting to go.
--
-- Four sliders over Shared/Audio's SoundGroups. Roblox already has a mixer --
-- a Sound in a SoundGroup is scaled by that group's Volume, and groups nest --
-- so a slider here is one number, and every sound in the game follows it,
-- including the ones already playing and the ones made later. Nothing in this
-- file knows what a Sound is.
--
-- WHY A SLIDER AND NOT A ROBLOX ONE. There is no built-in slider widget: a
-- slider in Roblox is a frame, a fill, a knob and the three input events below.
-- It is about forty lines and every one of them is here rather than in a
-- library that would have to be uploaded.
--
-- SESSION-ONLY, and worth saying plainly rather than letting it be discovered:
-- these do not persist across a rejoin. Roblox has no client-side storage, so
-- persisting them means a DataStore write, and this place has no DataStore
-- access at all right now -- ProfileService says so in its own log line on
-- every boot. When it does, four numbers go in the profile alongside the money
-- and this file gains a load and a save.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local UserInputService = game:GetService("UserInputService")
local TweenService = game:GetService("TweenService")

local player = Players.LocalPlayer
local Audio = require(ReplicatedStorage:WaitForChild("Shared"):WaitForChild("Audio"))

local INK = Color3.fromRGB(238, 240, 244)
local DIM = Color3.fromRGB(150, 156, 166)
local ACCENT = Color3.fromRGB(255, 140, 40)
local PANEL = Color3.fromRGB(18, 20, 24)

local gui = Instance.new("ScreenGui")
gui.Name = "Settings"
gui.ResetOnSpawn = false
gui.IgnoreGuiInset = true
-- Above the dispatch card and the minimap, below the loading screen (1000).
gui.DisplayOrder = 50
gui.Parent = player:WaitForChild("PlayerGui")

-- ---------------------------------------------------------------- the button

-- BOTTOM RIGHT, which is the only corner not already spoken for: Roblox's own
-- topbar owns the top left, the minimap the top right, and the dispatch card
-- the bottom left. The wallet sits above the card. This is the last free
-- corner and it is why the button is there rather than anywhere prettier.
local button = Instance.new("TextButton")
button.Name = "Open"
button.Size = UDim2.fromOffset(44, 44)
button.Position = UDim2.new(1, -62, 1, -62)
button.BackgroundColor3 = PANEL
button.BackgroundTransparency = 0.15
button.BorderSizePixel = 0
button.Text = "⚙"
button.TextSize = 24
button.TextColor3 = INK
button.Font = Enum.Font.GothamMedium
button.AutoButtonColor = true
button.Parent = gui
local bCorner = Instance.new("UICorner")
bCorner.CornerRadius = UDim.new(1, 0)
bCorner.Parent = button

-- ---------------------------------------------------------------- the panel

local panel = Instance.new("Frame")
panel.Name = "Panel"
panel.Size = UDim2.fromOffset(320, 300)
panel.Position = UDim2.new(0.5, -160, 0.5, -150)
panel.BackgroundColor3 = PANEL
panel.BackgroundTransparency = 0.06
panel.BorderSizePixel = 0
panel.Visible = false
panel.Parent = gui
local pCorner = Instance.new("UICorner")
pCorner.CornerRadius = UDim.new(0, 8)
pCorner.Parent = panel

local function label(parent: Instance, pos: UDim2, size: UDim2, str: string, sz: number, colour: Color3, font: Enum.Font): TextLabel
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

label(panel, UDim2.new(0, 20, 0, 16), UDim2.new(1, -40, 0, 18), "SETTINGS", 12, ACCENT, Enum.Font.GothamMedium)
label(panel, UDim2.new(0, 20, 0, 34), UDim2.new(1, -40, 0, 22), "Sound", 18, INK, Enum.Font.GothamBold)

local close = Instance.new("TextButton")
close.Size = UDim2.fromOffset(28, 28)
close.Position = UDim2.new(1, -38, 0, 14)
close.BackgroundTransparency = 1
close.Text = "X"
close.TextSize = 18
close.TextColor3 = DIM
close.Font = Enum.Font.GothamMedium
close.Parent = panel

-- ---------------------------------------------------------------- a slider

-- Dragging is three events and one piece of state. InputBegan on the TRACK
-- starts it (so you can click anywhere on the bar, not just grab the knob),
-- InputChanged anywhere on screen moves it, InputEnded anywhere ends it.
--
-- ANYWHERE, not on the track: a drag that only follows the pointer while it is
-- still over a four-pixel-tall bar is a drag that stops the moment you move
-- your hand, which is how a slider feels broken without being broken.
local dragging: Frame? = nil
local onDrag: { [Frame]: (number) -> () } = {}

local function slider(y: number, name: string, initial: number, apply: (number) -> ())
	label(panel, UDim2.new(0, 20, 0, y), UDim2.new(0, 150, 0, 18), name, 14, INK, Enum.Font.Gotham)

	local readout = label(
		panel,
		UDim2.new(1, -70, 0, y),
		UDim2.new(0, 50, 0, 18),
		"",
		13,
		DIM,
		Enum.Font.GothamMedium
	)
	readout.TextXAlignment = Enum.TextXAlignment.Right

	local track = Instance.new("Frame")
	track.Size = UDim2.new(1, -40, 0, 6)
	track.Position = UDim2.new(0, 20, 0, y + 24)
	track.BackgroundColor3 = Color3.fromRGB(44, 48, 56)
	track.BorderSizePixel = 0
	track.Parent = panel
	local tc = Instance.new("UICorner")
	tc.CornerRadius = UDim.new(1, 0)
	tc.Parent = track

	local fill = Instance.new("Frame")
	fill.Size = UDim2.fromScale(initial, 1)
	fill.BackgroundColor3 = ACCENT
	fill.BorderSizePixel = 0
	fill.Parent = track
	local fc = Instance.new("UICorner")
	fc.CornerRadius = UDim.new(1, 0)
	fc.Parent = fill

	local knob = Instance.new("Frame")
	knob.Size = UDim2.fromOffset(14, 14)
	knob.AnchorPoint = Vector2.new(0.5, 0.5)
	knob.Position = UDim2.new(initial, 0, 0.5, 0)
	knob.BackgroundColor3 = INK
	knob.BorderSizePixel = 0
	knob.ZIndex = 2
	knob.Parent = track
	local kc = Instance.new("UICorner")
	kc.CornerRadius = UDim.new(1, 0)
	kc.Parent = knob

	local function set(v: number)
		v = math.clamp(v, 0, 1)
		fill.Size = UDim2.fromScale(v, 1)
		knob.Position = UDim2.new(v, 0, 0.5, 0)
		readout.Text = ("%d%%"):format(math.floor(v * 100 + 0.5))
		apply(v)
	end
	set(initial)

	onDrag[track] = function(px: number)
		set((px - track.AbsolutePosition.X) / math.max(track.AbsoluteSize.X, 1))
	end

	track.InputBegan:Connect(function(input)
		if
			input.UserInputType == Enum.UserInputType.MouseButton1
			or input.UserInputType == Enum.UserInputType.Touch
		then
			dragging = track
			onDrag[track](input.Position.X)
		end
	end)
end

UserInputService.InputChanged:Connect(function(input)
	if not dragging then
		return
	end
	if
		input.UserInputType == Enum.UserInputType.MouseMovement
		or input.UserInputType == Enum.UserInputType.Touch
	then
		local fn = onDrag[dragging :: Frame]
		if fn then
			fn(input.Position.X)
		end
	end
end)

UserInputService.InputEnded:Connect(function(input)
	if
		input.UserInputType == Enum.UserInputType.MouseButton1
		or input.UserInputType == Enum.UserInputType.Touch
	then
		dragging = nil
	end
end)

-- ---------------------------------------------------------------- the mixer

-- The order is the order you reach for them. Master first because it is the one
-- that means "quieter, please"; the rest are for balance.
slider(76, "Master", Audio.getVolume("Master"), function(v)
	Audio.setVolume("Master", v)
end)
slider(126, "Engine", Audio.getVolume("Engine"), function(v)
	Audio.setVolume("Engine", v)
end)
slider(176, "Crashes and fire", Audio.getVolume("Effects"), function(v)
	Audio.setVolume("Effects", v)
end)
slider(226, "Dispatch tones", Audio.getVolume("Interface"), function(v)
	Audio.setVolume("Interface", v)
end)

label(
	panel,
	UDim2.new(0, 20, 1, -30),
	UDim2.new(1, -40, 0, 18),
	"O to open  ·  settings last for this session",
	11,
	Color3.fromRGB(96, 102, 112),
	Enum.Font.Gotham
)

-- ---------------------------------------------------------------- open, shut

local open = false
local function setOpen(v: boolean)
	open = v
	panel.Visible = v
	button.Text = if v then "X" else "⚙"
	-- Nudged rather than hidden while open, so the corner does not empty out.
	TweenService:Create(button, TweenInfo.new(0.15), {
		BackgroundTransparency = if v then 0.45 else 0.15,
	}):Play()
end

button.Activated:Connect(function()
	setOpen(not open)
end)
close.Activated:Connect(function()
	setOpen(false)
end)

-- O rather than Escape: Escape is Roblox's own menu and cannot be taken, and
-- every other letter near it is a driving control.
UserInputService.InputBegan:Connect(function(input, processed)
	if processed then
		return
	end
	if input.KeyCode == Enum.KeyCode.O then
		setOpen(not open)
	end
end)
