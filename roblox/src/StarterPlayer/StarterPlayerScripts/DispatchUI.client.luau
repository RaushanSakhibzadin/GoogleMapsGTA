--!strict
-- The dispatch card, the marker over the incident, and the claim.
--
-- DELIBERATELY PLAIN. The plan says the browser game's UI is replaceable and
-- that nothing may carry the vocabulary of the game it homages -- so this uses
-- dispatch language throughout: DISPATCH, RESPOND, ON SCENE, RESOLVED. No
-- stars, no wanted level, nothing borrowed. It is also the M2 UI: one card, one
-- button, one beam. The design pass comes when there is more than one role to
-- design for.
--
-- The nearest open incident is the one offered. Choosing between a board of
-- them is a map, and there is no map yet.
--
-- THE FIRE IS A FIRE NOW, not a marker: every incident on the board burns, with
-- flame, glow, smoke and a beacon over it (CityVisual/FireFX). It dies down as
-- the work gets done, and it BLINKS while you are working it -- which is the
-- one piece of state that was previously only readable from the card.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local UserInputService = game:GetService("UserInputService")

local player = Players.LocalPlayer
local Remotes = ReplicatedStorage:WaitForChild("Remotes")
local Shared = ReplicatedStorage:WaitForChild("Shared")
local Audio = require(Shared:WaitForChild("Audio"))
local FireFX = require(ReplicatedStorage:WaitForChild("CityVisual"):WaitForChild("FireFX"))

local Board = Remotes:WaitForChild("IncidentBoard") :: RemoteEvent
local Claim = Remotes:WaitForChild("ClaimSlot") :: RemoteFunction
local Wallet = Remotes:WaitForChild("Wallet") :: RemoteEvent

local board: { any } = {}
local mine: string? = nil
local money = 0

-- ---------------------------------------------------------------- the screen

local gui = Instance.new("ScreenGui")
gui.Name = "Dispatch"
gui.ResetOnSpawn = false
gui.IgnoreGuiInset = true
gui.Parent = player:WaitForChild("PlayerGui")

local function label(parent: Instance, size: UDim2, pos: UDim2, text: string, sz: number, colour: Color3)
	local t = Instance.new("TextLabel")
	t.BackgroundTransparency = 1
	t.Size = size
	t.Position = pos
	t.Font = Enum.Font.GothamMedium
	t.Text = text
	t.TextSize = sz
	t.TextColor3 = colour
	t.TextXAlignment = Enum.TextXAlignment.Left
	t.Parent = parent
	return t
end

local card = Instance.new("Frame")
card.Size = UDim2.new(0, 340, 0, 128)
card.Position = UDim2.new(0, 18, 1, -152)
card.BackgroundColor3 = Color3.fromRGB(18, 20, 24)
card.BackgroundTransparency = 0.15
card.BorderSizePixel = 0
card.Parent = gui
local corner = Instance.new("UICorner")
corner.CornerRadius = UDim.new(0, 6)
corner.Parent = card

local kicker = label(card, UDim2.new(1, -24, 0, 16), UDim2.new(0, 12, 0, 10), "DISPATCH", 12, Color3.fromRGB(255, 176, 64))
local title = label(card, UDim2.new(1, -24, 0, 22), UDim2.new(0, 12, 0, 28), "", 18, Color3.fromRGB(238, 240, 244))
local detail = label(card, UDim2.new(1, -24, 0, 34), UDim2.new(0, 12, 0, 52), "", 13, Color3.fromRGB(150, 156, 166))
detail.TextWrapped = true
local status = label(card, UDim2.new(1, -24, 0, 16), UDim2.new(0, 12, 0, 92), "", 13, Color3.fromRGB(120, 200, 150))

local bar = Instance.new("Frame")
bar.Size = UDim2.new(1, -24, 0, 3)
bar.Position = UDim2.new(0, 12, 1, -12)
bar.BackgroundColor3 = Color3.fromRGB(46, 50, 58)
bar.BorderSizePixel = 0
bar.Parent = card
local fill = Instance.new("Frame")
fill.Size = UDim2.new(0, 0, 1, 0)
fill.BackgroundColor3 = Color3.fromRGB(255, 176, 64)
fill.BorderSizePixel = 0
fill.Parent = bar

-- UNDER THE CARD, NOT AT THE TOP OF THE SCREEN. The first attempt put this at
-- (18, 14), which is exactly where Roblox's own topbar buttons sit -- with
-- IgnoreGuiInset on, the game's UI and the platform's share that corner and the
-- platform wins. Sitting it above the dispatch card keeps everything the player
-- reads in one place anyway.
local wallet = label(card, UDim2.new(1, -24, 0, 22), UDim2.new(0, 12, 0, -28), "$0", 20, Color3.fromRGB(238, 240, 244))
wallet.TextXAlignment = Enum.TextXAlignment.Right

-- ---------------------------------------------------------------- the fires

-- ONE FIRE PER INCIDENT ON THE BOARD, not one marker for the one being offered.
-- There are at most four at a time and a burning building three streets away is
-- the best possible signpost -- much better than a card telling you a bearing.
local fires = Instance.new("Folder")
fires.Name = "Incidents"
fires.Parent = workspace

local rigs: { [string]: FireFX.Rig } = {}
-- A Sound once attached, `false` once the slot is known to be silent, nil while
-- it is still being resolved. The three states are what stop this retrying for
-- ever on a build with no audio.
local burn: { [string]: (Sound | boolean)? } = {}

-- Each fire gets its own clock so they do not all blink in lockstep, keyed off
-- the incident id -- so it is stable for as long as the fire is, rather than
-- shuffling every time the board is rebroadcast.
local phase: { [string]: number } = {}
local function phaseOf(id: string): number
	local p = phase[id]
	if not p then
		p = math.random() * 100
		phase[id] = p
	end
	return p
end

-- ---------------------------------------------------------------- the siren

-- ON WHILE YOU ARE RESPONDING, off once you are on scene -- which is what a
-- siren is for: it clears the road on the way there and is switched off at the
-- incident. It is one tone alternating between two pitches about once a second,
-- because a two-tone siren IS two pitches of one note and there is nothing in
-- the client's sound library that is a siren.
local siren: (Sound | boolean)? = nil
local sirenOn = false

local function updateSiren(want: boolean, t: number)
	if siren == nil then
		local cars = workspace:FindFirstChild("Cars")
		local model = cars and cars:FindFirstChild("Car_" .. player.UserId)
		local body = if model and model:IsA("Model") then model.PrimaryPart else nil
		if body then
			local s = Audio.make("siren", body)
			if s then
				local snd = s :: Sound
				snd.Name = "Siren"
				snd.Looped = true
				snd.Volume = 0
				snd.RollOffMaxDistance = 320
				snd:Play()
				siren = snd
			else
				siren = false
			end
		end
	end

	if typeof(siren) ~= "Instance" then
		return
	end
	local snd = siren :: Sound
	sirenOn = want
	-- Eased rather than switched, so it winds up and down instead of clicking on.
	local target = if want then 0.28 else 0
	snd.Volume += (target - snd.Volume) * 0.08
	snd.PlaybackSpeed = if math.sin(t * 6.2) > 0 then 1.35 else 1.0
end

-- ---------------------------------------------------------------- state

Wallet.OnClientEvent:Connect(function(n)
	money = n
	wallet.Text = "$" .. tostring(n)
end)

-- A NEW JOB PINGS ONCE, and only for a genuinely new id. The board is
-- rebroadcast four times a second with progress on it, so comparing the whole
-- list would ping continuously; comparing ids is what makes "new" mean new.
local known: { [string]: boolean } = {}
Board.OnClientEvent:Connect(function(list)
	local fresh: { [string]: boolean } = {}
	local anyNew = false
	for _, e in list do
		fresh[e.id] = true
		if not known[e.id] then
			anyNew = true
		end
	end
	-- RESOLVED IS ALSO WORTH A NOISE, and a different one: the job you were on
	-- disappearing off the board is the only signal that it finished.
	if mine and not fresh[mine] then
		Audio.shot("ping", nil, 0.45, 1.5)
	end
	if anyNew and next(known) ~= nil then
		-- Not on the first board of the session, which arrives with four jobs on
		-- it and would otherwise open the game with a burst of pings.
		Audio.shot("ping", nil, 0.28, 0.85)
	end
	known = fresh
	board = list
end)

local function carPos(): Vector3?
	local cars = workspace:FindFirstChild("Cars")
	local model = cars and cars:FindFirstChild("Car_" .. player.UserId)
	if model and model:IsA("Model") then
		return model:GetPivot().Position
	end
	return nil
end

-- The one being offered: whichever I am on, else the nearest that has room.
local function current(from: Vector3?)
	local best, bestD = nil, math.huge
	for _, inc in board do
		if mine and inc.id == mine then
			return inc
		end
		if from and inc.filled < inc.max then
			local d = (Vector2.new(inc.x, inc.z) - Vector2.new(from.X, from.Z)).Magnitude
			if d < bestD then
				best, bestD = inc, d
			end
		end
	end
	return best
end

-- ---------------------------------------------------------------- the claim

-- The token is what makes a retry safe. If the reply is lost the client can
-- send the same request again and the server treats it as the same claim
-- rather than a second one, so a dropped packet cannot cost a slot.
local claiming = false
local function respond(inc)
	if claiming or not inc then
		return
	end
	claiming = true
	local token = ("%d-%s-%d"):format(player.UserId, inc.id, math.floor(os.clock() * 1000))
	local ok, why = Claim:InvokeServer(inc.id, "fire", token)
	if ok then
		mine = inc.id
		Audio.shot("click", nil, 0.5, 1)
	else
		status.Text = "DISPATCH: " .. tostring(why)
		Audio.shot("click", nil, 0.35, 0.6)
	end
	claiming = false
end

UserInputService.InputBegan:Connect(function(input, processed)
	if processed then
		return
	end
	if input.KeyCode == Enum.KeyCode.E then
		respond(current(carPos()))
	end
end)

-- ---------------------------------------------------------------- the frame

RunService.RenderStepped:Connect(function()
	local from = carPos()
	local inc = current(from)
	local now = os.clock()

	-- ---- every fire on the board, whether or not it is the one offered ----
	local seen: { [string]: boolean } = {}
	for _, e in board do
		seen[e.id] = true
		local rig = rigs[e.id]
		if not rig then
			rig = FireFX.new(fires)
			rigs[e.id] = rig
		end

		-- Attached once, when the fire is made. Audio.make no longer has a "not
		-- ready yet" answer to cope with.
		if burn[e.id] == nil then
			local s = Audio.make("fire", rig.seat)
			if s then
				local snd = s :: Sound
				snd.Looped = true
				snd.Volume = 0.3
				snd.PlaybackSpeed = 0.35
				snd.RollOffMaxDistance = 420
				snd.RollOffMinDistance = 40
				snd:Play()
				burn[e.id] = snd
			else
				burn[e.id] = false -- silent, stop asking
			end
		end

		-- FOUGHT means on scene AND signed on -- not merely nearby. Driving past
		-- somebody else's fire should not make it blink at you.
		local fought = false
		if mine == e.id and from then
			local d = (Vector2.new(e.x, e.z) - Vector2.new(from.X, from.Z)).Magnitude
			fought = d <= e.radius
		end

		FireFX.update(rig, e.x, e.z, e.progress or 0, fought, now + phaseOf(e.id))

		local snd = burn[e.id]
		if typeof(snd) == "Instance" then
			-- The fire quietens as it goes out, which is the same information the
			-- flame is carrying, arriving through the other ear.
			(snd :: Sound).Volume = 0.3 * math.clamp(1 - (e.progress or 0), 0.05, 1)
		end
	end

	-- ---- and take away the ones that resolved or expired ----
	for id, rig in rigs do
		if not seen[id] then
			FireFX.destroy(rig)
			rigs[id] = nil
			burn[id] = nil
			phase[id] = nil
		end
	end

	if not inc then
		card.Visible = false
		updateSiren(false, now)
		mine = nil
		return
	end
	card.Visible = true

	-- If the board no longer lists the one I was on, it resolved or expired.
	if mine and inc.id ~= mine then
		mine = nil
	end

	title.Text = inc.label
	detail.Text = inc.detail .. (if inc.name ~= "" then "  ·  " .. inc.name else "")
	fill.Size = UDim2.new(math.clamp(inc.progress, 0, 1), 0, 1, 0)

	local d = if from then (Vector2.new(inc.x, inc.z) - Vector2.new(from.X, from.Z)).Magnitude else 0
	local metres = math.floor(d / 3)

	-- RESPONDING, not merely signed on: the siren goes off when you arrive.
	updateSiren(mine == inc.id and d > inc.radius, now)

	if mine == inc.id then
		if d <= inc.radius then
			status.Text = ("ON SCENE  ·  %d/%d responding  ·  $%d")
				:format(inc.filled, inc.max, inc.pay)
			status.TextColor3 = Color3.fromRGB(120, 200, 150)
		else
			status.Text = ("RESPONDING  ·  %d m  ·  %d/%d"):format(metres, inc.filled, inc.max)
			status.TextColor3 = Color3.fromRGB(255, 176, 64)
		end
	else
		status.Text = ("[E] RESPOND  ·  %d m  ·  %d/%d  ·  $%d")
			:format(metres, inc.filled, inc.max, inc.pay)
		status.TextColor3 = Color3.fromRGB(150, 156, 166)
	end
end)
