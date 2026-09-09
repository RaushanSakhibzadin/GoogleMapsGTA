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
-- REQUIRED THROUGH A PCALL, WITH A SILENT STUB IF IT FAILS. Sound is optional;
-- the fires and the dispatch card are not. See the same note in
-- VehicleController for the round trip that paid for this.
local Audio = (function()
	local ok, m = pcall(require, Shared:WaitForChild("Audio"))
	if ok then
		return m
	end
	warn("[audio] failed to load (" .. tostring(m) .. ") -- carrying on in silence")
	return {
		warm = function() end,
		make = function(): Sound?
			return nil
		end,
		shot = function() end,
	}
end)()
local FireFX = require(ReplicatedStorage:WaitForChild("CityVisual"):WaitForChild("FireFX"))
local ClientBus = require(Shared:WaitForChild("ClientBus"))
local Roles = require(Shared:WaitForChild("Roles"))

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

-- THE COLUMN'S COLOUR IS THE SERVICE IT WANTS, which is the whole of what a
-- marker can say from a kilometre away. Blue is police, and it is the blue the
-- patrol cars and the minimap's police blips already use; red is fire; the
-- green is the ambulance flash; and the two errands wear the paint of the shift
-- that runs them.
--
-- It arrives on the board rather than being repeated here: it is the same
-- number the minimap and the big map draw their blips with, and one palette in
-- IncidentTypes is what stops the beacon you drove towards being a different
-- colour from the dot you drove towards it from.
local FALLBACK = Color3.fromRGB(255, 140, 40)

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

-- MY SLOT ON AN INCIDENT, or nil if this shift has no place on it. This is what
-- turned the card from "the nearest job" into "the nearest job I can do": with
-- five services and five kinds, most of the board is somebody else's work, and
-- offering a firefighter a fare is offering them a button that fails.
local function slotFor(inc): { role: string, max: number, filled: number }?
	local role = ClientBus.role
	for _, s in inc.slots or {} do
		if s.role == role then
			return s
		end
	end
	return nil
end

-- The one being offered: whichever I am on, else the nearest my shift can take
-- and that still has room in my role's slot.
local function current(from: Vector3?)
	local best, bestD = nil, math.huge
	for _, inc in board do
		if mine and inc.id == mine then
			return inc
		end
		local s = slotFor(inc)
		if from and s and s.filled < s.max and not (inc.competitive and inc.progress > 0) then
			local d = (Vector2.new(inc.x, inc.z) - Vector2.new(from.X, from.Z)).Magnitude
			if d < bestD then
				best, bestD = inc, d
			end
		end
	end
	return best
end

-- WHAT THE BOARD STILL WANTS, in words rather than in a fraction. "1/4" on a
-- road collision does not tell you that the ambulance is the one missing, and
-- that is the only part a player can act on -- either by driving there or by
-- telling somebody else to.
local function needs(inc): string
	local out = {}
	for _, s in inc.slots or {} do
		if s.filled < s.max then
			out[#out + 1] = Roles.get(s.role).short
		end
	end
	if #out == 0 then
		return "CREWED"
	end
	return "NEEDS " .. table.concat(out, " + ")
end

-- ---------------------------------------------------------------- the claim

-- WHY THE BUTTON DID NOT WORK, held on screen long enough to read.
--
-- The refusal used to be written straight into `status` -- and `status` is
-- rewritten by the frame loop below, so the message survived exactly one frame
-- and was invisible. That was survivable while the only possible refusal was
-- "role full" on the one kind of job. It is not survivable now: "not on that
-- shift" is the commonest thing the server will say to a player who has not
-- worked out that the depots are the point.
local sayUntil = 0
local saying = ""
local function say(text: string)
	saying = text
	sayUntil = os.clock() + 2.5
end

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
	-- THE SHIFT YOU ARE ON, not the kind of incident it is. The server checks
	-- this against its own record and refuses a mismatch, so sending the wrong
	-- one is a refusal rather than an exploit -- but sending the right one is
	-- what makes the button work at all.
	local ok, why = Claim:InvokeServer(inc.id, ClientBus.role, token)
	if ok then
		mine = inc.id
		Audio.shot("click", nil, 0.5, 1)
	else
		say("DISPATCH: " .. tostring(why))
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
			-- ONLY A FIRE BURNS. Every incident gets the beacon, the glow and the
			-- column over it -- that is what makes a job three streets away
			-- findable without reading a bearing off a card -- but a road
			-- collision is not on fire and a fare is certainly not, and lighting
			-- them all identically would throw away the one piece of information
			-- the marker gives you for free.
			rig = FireFX.new(fires, e.marker == "fire", e.colour or FALLBACK)
			rigs[e.id] = rig
		end

		-- Attached once, when the fire is made. Audio.make no longer has a "not
		-- ready yet" answer to cope with.
		if burn[e.id] == nil then
			-- Only the ones that are actually alight. A collision does not roar.
			local s = if e.marker == "fire" then Audio.make("fire", rig.seat) else nil
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
		-- THE BOARD IS NOT EMPTY JUST BECAUSE NONE OF IT IS YOURS, and saying so
		-- is the difference between "there is nothing to do" and "you are on the
		-- wrong shift for what there is". The second has an answer and the player
		-- can act on it; hiding the card leaves them believing the first.
		local elsewhere = 0
		for _, e in board do
			if e.state ~= "resolved" then
				elsewhere += 1
			end
		end
		if elsewhere > 0 then
			card.Visible = true
			kicker.Text = "DISPATCH"
			title.Text = "Nothing for this shift"
			detail.Text = ("%d job%s on the board for other services. Sign on at a depot to take one.")
				:format(elsewhere, if elsewhere == 1 then "" else "s")
			status.Text = "ON  ·  " .. Roles.get(ClientBus.role).title
			status.TextColor3 = Color3.fromRGB(150, 156, 166)
			fill.Size = UDim2.new(0, 0, 1, 0)
		else
			card.Visible = false
		end
		updateSiren(false, now)
		ClientBus.responding = false
		ClientBus.myIncident = nil
		mine = nil
		return
	end
	card.Visible = true
	kicker.Text = inc.title or "DISPATCH"

	-- If the board no longer lists the one I was on, it resolved or expired.
	if mine and inc.id ~= mine then
		mine = nil
	end

	title.Text = inc.label
	detail.Text = inc.detail .. (if inc.name ~= "" then "  ·  " .. inc.name else "")
	fill.Size = UDim2.new(math.clamp(inc.progress, 0, 1), 0, 1, 0)

	local d = if from then (Vector2.new(inc.x, inc.z) - Vector2.new(from.X, from.Z)).Magnitude else 0
	local metres = math.floor(d / 3)

	-- RESPONDING, not merely signed on: the siren goes off when you arrive, and
	-- so does the beacon RoleUI flashes off the same flag.
	local responding = mine == inc.id and d > inc.radius
	updateSiren(responding, now)
	ClientBus.responding = responding
	ClientBus.myIncident = if responding then { x = inc.x, z = inc.z } else nil

	if now < sayUntil then
		-- A refusal wins the line for as long as it is up. It is the only thing
		-- on the card that is news.
		status.Text = saying
		status.TextColor3 = Color3.fromRGB(232, 116, 108)
	elseif mine == inc.id then
		if d <= inc.radius then
			status.Text = ("ON SCENE  ·  %s  ·  $%d"):format(needs(inc), inc.pay)
			status.TextColor3 = Color3.fromRGB(120, 200, 150)
		else
			status.Text = ("RESPONDING  ·  %d m  ·  %s"):format(metres, needs(inc))
			status.TextColor3 = Color3.fromRGB(255, 176, 64)
		end
	elseif inc.competitive then
		-- A RACE SAYS SO. "2/8 responding" on a fare reads as a job that is
		-- filling up, which is the opposite of the truth: every one of those is
		-- somebody you are racing, and only the first arrival is paid.
		status.Text = ("[E] TAKE IT  ·  %d m  ·  %d racing  ·  $%d")
			:format(metres, inc.filled, inc.pay)
		status.TextColor3 = Color3.fromRGB(242, 183, 5)
	else
		status.Text = ("[E] RESPOND  ·  %d m  ·  %s  ·  $%d"):format(metres, needs(inc), inc.pay)
		status.TextColor3 = Color3.fromRGB(150, 156, 166)
	end
end)
