--!strict
-- SETTINGS: the sound mixer and reverse steering, both persisted.
--
-- Four sliders over Shared/Audio's SoundGroups. Roblox already has a mixer --
-- a Sound in a SoundGroup is scaled by that group's Volume, and groups nest --
-- so a slider here is one number, and every sound in the game follows it,
-- including the ones already playing and the ones made later. Nothing in this
-- file knows what a Sound is. Below it, one toggle over ClientBus.revSteer,
-- the same preference js/entities.js's own REV_REAL is.
--
-- WHY A SLIDER AND NOT A ROBLOX ONE. There is no built-in slider widget: a
-- slider in Roblox is a frame, a fill, a knob and the three input events below.
-- It is about forty lines and every one of them is here rather than in a
-- library that would have to be uploaded.
--
-- PERSISTED THROUGH THE PROFILE, not local storage -- Roblox has none on the
-- client. ServerScriptService/SettingsServer.server.luau is the other half:
-- it pushes Remotes.Settings once a profile is loaded (this file's first
-- OnClientEvent, arriving after this UI has already built itself with
-- Audio's session defaults) and again on anything that changes it, and it
-- takes a patch back the same way. THE TWO DIRECTIONS MUST NOT LOOP: a value
-- arriving from the server updates the widget through its raw setter, never
-- through the same path a drag or a click uses, or an echoed update would
-- read as a new user edit and send straight back out.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local UserInputService = game:GetService("UserInputService")
local TweenService = game:GetService("TweenService")

local player = Players.LocalPlayer
local Shared = ReplicatedStorage:WaitForChild("Shared")
local Audio = require(Shared:WaitForChild("Audio"))
local ClientBus = require(Shared:WaitForChild("ClientBus"))

local Remotes = ReplicatedStorage:WaitForChild("Remotes")
local SettingsRemote = Remotes:WaitForChild("Settings") :: RemoteEvent

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
panel.Size = UDim2.fromOffset(320, 380)
panel.Position = UDim2.new(0.5, -160, 0.5, -190)
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

-- `groupKey` is the Remotes.Settings volume key this slider persists under;
-- `apply` is the LOCAL effect only (Audio.setVolume) and must never itself
-- reach the network -- the raw `set` this returns is what a server-driven
-- update calls, and a `set` that sent a patch would echo every load straight
-- back out. Dragging is the only path that does; see onDrag below.
local function slider(y: number, name: string, groupKey: string, initial: number, apply: (number) -> ()): (number) -> ()
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

	-- THE ONLY PATH THAT SENDS. A drag is the user changing their mind, so
	-- every point along it -- not just the release -- goes out: dragging is a
	-- few seconds at most, and ProfileService's own write cadence (every
	-- SAVE_EVERY seconds if dirty) is what stands between this and a
	-- DataStore throttle, not anything sent from here.
	onDrag[track] = function(px: number)
		local v = math.clamp((px - track.AbsolutePosition.X) / math.max(track.AbsoluteSize.X, 1), 0, 1)
		set(v)
		SettingsRemote:FireServer({ volume = { [groupKey] = v } })
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

	return set
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
-- that means "quieter, please"; the rest are for balance. Each returns its raw
-- setter, kept below so a settings payload from the server can move the
-- widget without the send-to-server side effect a drag has.
local volumeSetters: { [string]: (number) -> () } = {}
volumeSetters.Master = slider(76, "Master", "Master", Audio.getVolume("Master"), function(v)
	Audio.setVolume("Master", v)
end)
volumeSetters.Engine = slider(126, "Engine", "Engine", Audio.getVolume("Engine"), function(v)
	Audio.setVolume("Engine", v)
end)
volumeSetters.Effects = slider(176, "Crashes and fire", "Effects", Audio.getVolume("Effects"), function(v)
	Audio.setVolume("Effects", v)
end)
volumeSetters.Interface = slider(226, "Dispatch tones", "Interface", Audio.getVolume("Interface"), function(v)
	Audio.setVolume("Interface", v)
end)

-- --------------------------------------------------------------- a toggle

-- A two-state button rather than a slider: STICK or CAR, the same choice
-- js/io.js's revBtn offers, and the same reason a slider would be wrong for
-- it -- there is no in-between amount of reverse steering.
local function toggle(y: number, name: string, initial: boolean, apply: (boolean) -> ()): (boolean) -> ()
	label(panel, UDim2.new(0, 20, 0, y), UDim2.new(0, 180, 0, 18), name, 14, INK, Enum.Font.Gotham)

	local btn = Instance.new("TextButton")
	btn.Size = UDim2.fromOffset(84, 26)
	btn.Position = UDim2.new(1, -104, 0, y - 4)
	btn.BorderSizePixel = 0
	btn.Font = Enum.Font.GothamMedium
	btn.TextSize = 12
	btn.TextColor3 = INK
	btn.AutoButtonColor = true
	btn.Parent = panel
	local bc = Instance.new("UICorner")
	bc.CornerRadius = UDim.new(1, 0)
	bc.Parent = btn

	local state = initial
	local function set(v: boolean)
		state = v
		btn.Text = if v then "CAR" else "STICK"
		btn.BackgroundColor3 = if v then ACCENT else Color3.fromRGB(44, 48, 56)
		apply(v)
	end
	set(initial)

	-- SAME RULE AS THE SLIDER'S onDrag: this is the only path that sends,
	-- because it is the only path a person actually clicked.
	btn.Activated:Connect(function()
		set(not state)
		SettingsRemote:FireServer({ revSteer = not state })
	end)

	return set
end

label(panel, UDim2.new(0, 20, 0, 276), UDim2.new(1, -40, 0, 22), "Controls", 18, INK, Enum.Font.GothamBold)
local setRevSteer = toggle(312, "Reverse steering", ClientBus.revSteer, function(v)
	ClientBus.revSteer = v
end)

label(
	panel,
	UDim2.new(0, 20, 1, -22),
	UDim2.new(1, -40, 0, 18),
	"O to open",
	11,
	Color3.fromRGB(96, 102, 112),
	Enum.Font.Gotham
)

-- ------------------------------------------------------------ persistence

-- THE OTHER DIRECTION. ServerScriptService/SettingsServer.server.luau sends
-- this once the profile has loaded (after this UI already built itself with
-- Audio's session defaults above, hence the snap the first time it arrives)
-- and again on anything that changes the same document -- so every payload
-- is applied, not just the first, and always through the raw setters, never
-- through a path that would send it straight back.
SettingsRemote.OnClientEvent:Connect(function(settings)
	if typeof(settings) ~= "table" then
		return
	end
	if typeof(settings.volume) == "table" then
		for group, v in settings.volume :: { [string]: number } do
			local set = volumeSetters[group]
			if set and typeof(v) == "number" then
				set(v)
			end
		end
	end
	if typeof(settings.revSteer) == "boolean" then
		setRevSteer(settings.revSteer)
	end
end)

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
