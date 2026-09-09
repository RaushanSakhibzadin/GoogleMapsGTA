--!strict
-- THE WANTED HUD: five stars, an armour bar, the pursuit cars chasing you,
-- and the banner when you go down. One file because all four are the same
-- system seen from the client -- Remotes.WantedState/CopState are the only
-- two things this script listens for, the same way DispatchUI owns the card
-- AND the fires AND the siren rather than splitting a state's presentation
-- across files.
--
-- js/render.js's own drawHUD is the reference for the stars and the bar
-- (ceil(wanted) stars lit, hp colour banded green/amber/red) -- this is that
-- function, in Roblox's own widgets rather than a canvas and a DOM node.
--
-- COP CARS ARE RENDERED, NOT SIMULATED, here -- Services/WantedService.luau
-- runs the pursuit; Remotes.CopState is a position broadcast, the same
-- direction Traffic/Pedestrians positions flow except SERVER to CLIENT
-- instead of client-local, and CarBuild.npc builds the model exactly the way
-- Life.client.luau already builds one for a background police-liveried
-- civilian. No interpolation between updates (CopState arrives at 15 Hz) --
-- a visible but small rough edge against the 60 Hz the player's own car
-- moves at, left as a known follow-up rather than solved here.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local player = Players.LocalPlayer
local Shared = ReplicatedStorage:WaitForChild("Shared")
local ClientBus = require(Shared:WaitForChild("ClientBus"))
local Loc = require(Shared:WaitForChild("Loc"))
local CarBuild = require(Shared:WaitForChild("CarBuild"))
local Roles = require(Shared:WaitForChild("Roles"))

local Remotes = ReplicatedStorage:WaitForChild("Remotes")
local WantedState = Remotes:WaitForChild("WantedState") :: RemoteEvent
local CopState = Remotes:WaitForChild("CopState") :: RemoteEvent

local INK = Color3.fromRGB(238, 240, 244)
local GOLD = Color3.fromRGB(255, 227, 106)

local gui = Instance.new("ScreenGui")
gui.Name = "Wanted"
gui.ResetOnSpawn = false
gui.IgnoreGuiInset = true
gui.DisplayOrder = 15
gui.Parent = player:WaitForChild("PlayerGui")

-- ---------------------------------------------------------------- the stars

-- TOP CENTRE, free space in this port's own layout: the wallet moved to the
-- bottom-left stack above the dispatch card (see DispatchUI's own note on
-- why), which frees the top-right AND top-centre js/render.js's #stars and
-- #hpWrap used -- no reason to fight either back off the corner they left.
local hud = Instance.new("Frame")
hud.Name = "HUD"
hud.AnchorPoint = Vector2.new(0.5, 0)
hud.Position = UDim2.new(0.5, 0, 0, 10)
hud.Size = UDim2.fromOffset(150, 40)
hud.BackgroundTransparency = 1
hud.Visible = false -- nothing to show until a wanted level or damage exists
hud.Parent = gui

local starsRow = Instance.new("Frame")
starsRow.Size = UDim2.new(1, 0, 0, 20)
starsRow.BackgroundTransparency = 1
starsRow.Parent = hud
local starsLayout = Instance.new("UIListLayout")
starsLayout.FillDirection = Enum.FillDirection.Horizontal
starsLayout.HorizontalAlignment = Enum.HorizontalAlignment.Center
starsLayout.Padding = UDim.new(0, 2)
starsLayout.Parent = starsRow

local stars: { TextLabel } = {}
for i = 1, 5 do
	local star = Instance.new("TextLabel")
	star.Size = UDim2.fromOffset(22, 20)
	star.BackgroundTransparency = 1
	star.Text = "★"
	star.TextSize = 22
	star.Font = Enum.Font.GothamBold
	star.TextColor3 = GOLD
	star.TextTransparency = 0.72 -- "off": dim, same as js/render.js's .off class
	star.Parent = starsRow
	stars[i] = star
end

-- ---------------------------------------------------------------- the armour bar

local barTrack = Instance.new("Frame")
barTrack.Size = UDim2.new(1, 0, 0, 8)
barTrack.Position = UDim2.new(0, 0, 0, 26)
barTrack.BackgroundColor3 = Color3.fromRGB(0, 0, 0)
barTrack.BackgroundTransparency = 0.45
barTrack.BorderSizePixel = 0
barTrack.Parent = hud
local barCorner = Instance.new("UICorner")
barCorner.CornerRadius = UDim.new(1, 0)
barCorner.Parent = barTrack

local barFill = Instance.new("Frame")
barFill.Size = UDim2.fromScale(1, 1)
barFill.BackgroundColor3 = Color3.fromRGB(72, 255, 158)
barFill.BorderSizePixel = 0
barFill.Parent = barTrack
local barFillCorner = Instance.new("UICorner")
barFillCorner.CornerRadius = UDim.new(1, 0)
barFillCorner.Parent = barFill

local function paintHUD(hp: number, wanted: number)
	hud.Visible = wanted > 0 or hp < 100
	local lit = math.ceil(wanted)
	for i, star in stars do
		star.TextTransparency = if i <= lit then 0 else 0.72
	end
	barFill.Size = UDim2.fromScale(math.clamp(hp, 0, 100) / 100, 1)
	barFill.BackgroundColor3 = if hp > 55
		then Color3.fromRGB(72, 255, 158)
		elseif hp > 25 then Color3.fromRGB(255, 227, 106)
		else Color3.fromRGB(255, 51, 85)
end

-- ---------------------------------------------------------------- the banner

local banner = Instance.new("Frame")
banner.Size = UDim2.fromScale(1, 1)
banner.BackgroundColor3 = Color3.fromRGB(0, 0, 0)
banner.BackgroundTransparency = 0.35
banner.Visible = false
banner.ZIndex = 100
banner.Parent = gui

local bannerTitle = Instance.new("TextLabel")
bannerTitle.AnchorPoint = Vector2.new(0.5, 0.5)
bannerTitle.Position = UDim2.new(0.5, 0, 0.42, 0)
bannerTitle.Size = UDim2.new(1, -40, 0, 64)
bannerTitle.BackgroundTransparency = 1
bannerTitle.Font = Enum.Font.GothamBlack
bannerTitle.TextSize = 46
bannerTitle.TextColor3 = INK
bannerTitle.ZIndex = 101
bannerTitle.Parent = banner

local bannerSub = Instance.new("TextLabel")
bannerSub.AnchorPoint = Vector2.new(0.5, 0.5)
bannerSub.Position = UDim2.new(0.5, 0, 0.42, 46)
bannerSub.Size = UDim2.new(1, -40, 0, 24)
bannerSub.BackgroundTransparency = 1
bannerSub.Font = Enum.Font.GothamMedium
bannerSub.TextSize = 16
bannerSub.TextColor3 = Color3.fromRGB(200, 204, 212)
bannerSub.ZIndex = 101
bannerSub.Parent = banner

-- ---------------------------------------------------------------- state in

local wasDown = false
WantedState.OnClientEvent:Connect(function(snap)
	if typeof(snap) ~= "table" then
		return
	end
	local hp = if typeof(snap.hp) == "number" then snap.hp else 100
	local wanted = if typeof(snap.wanted) == "number" then snap.wanted else 0
	local down = snap.down == true

	paintHUD(hp, wanted)
	ClientBus.down = down

	if down and not wasDown then
		local reason = tostring(snap.reason)
		if reason == "busted" then
			bannerTitle.Text = Loc.get("wanted.busted.title")
			bannerTitle.TextColor3 = Color3.fromRGB(51, 230, 255)
			local fine = if typeof(snap.fine) == "number" then snap.fine else 0
			bannerSub.Text = Loc.get("wanted.busted.sub"):format(fine)
		else
			bannerTitle.Text = Loc.get("wanted.down.title")
			bannerTitle.TextColor3 = Color3.fromRGB(255, 79, 216)
			bannerSub.Text = Loc.get("wanted.down.sub")
		end
		banner.Visible = true
	elseif not down and wasDown then
		banner.Visible = false
	end
	wasDown = down
end)

-- ---------------------------------------------------------------- pursuit cars

-- BUILT ONCE PER id, PLACED EVERY MESSAGE. Same shape as Life.client.luau's
-- own bodyFor: a model is made the first time an id is seen and kept until
-- CopState stops mentioning it, rather than rebuilt every broadcast.
local copModels: { [number]: Model } = {}
local seenThisMessage: { [number]: boolean } = {}
local police = Roles.get("police")

local beaconT = 0
CopState.OnClientEvent:Connect(function(list)
	if typeof(list) ~= "table" then
		return
	end
	table.clear(seenThisMessage)
	for _, k in list :: { any } do
		if typeof(k) ~= "table" or typeof(k.id) ~= "number" then
			continue
		end
		seenThisMessage[k.id] = true
		local model = copModels[k.id]
		if not model then
			model = CarBuild.npc(police.colour or Color3.new(1, 1, 1), CarBuild.LENGTH, CarBuild.WIDTH, CarBuild.HEIGHT, false, "police", police.beacon)
			model.Parent = workspace
			copModels[k.id] = model
		end
		CarBuild.place(model, k.x, k.y, k.h, model:GetAttribute("BodyY") :: number?)
	end
	for id, model in copModels do
		if not seenThisMessage[id] then
			model:Destroy()
			copModels[id] = nil
		end
	end
end)

-- THE SAME DOUBLE-FLASH PHASE as every other beacon in the game (RoleUI's own
-- copy of this loop has the fullest account of why two flashes and a gap
-- rather than a plain on/off) -- a pursuit car's lightbar reads as the same
-- kind of light as everything else wearing one.
RunService.Heartbeat:Connect(function(dt)
	if next(copModels) == nil then
		return
	end
	beaconT += dt
	local ph = (beaconT * 2.4) % 1
	local lit = ph < 0.09 or (ph > 0.16 and ph < 0.25)
	for _, model in copModels do
		for _, partName in { "BeaconL", "BeaconR" } do
			local bar = model:FindFirstChild(partName)
			if bar and bar:IsA("BasePart") then
				bar.Transparency = if lit then 0 else 0.62
				local light = bar:FindFirstChildOfClass("PointLight")
				if light then
					light.Brightness = if lit then 2.4 else 0
				end
			end
		end
	end
end)
