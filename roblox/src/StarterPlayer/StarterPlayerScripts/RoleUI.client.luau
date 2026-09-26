--!strict
-- THE SHIFT: the chip that says which one you are on, and the prompt at a depot.
--
-- Three jobs, and they are here together because they are all one question --
-- "what am I, and can I change it from where I am standing":
--
--   · the CHIP, top left under the wallet, in the shift's own colour
--   · the PROMPT, which appears when you stop at a depot that signs one on
--   · the HANDLING, because a shift changes the vehicle and the vehicle model
--     runs on the client
--
-- THE PROMPT IS DECIDED HERE AND AGREED THERE. This script works out what is on
-- offer from the depot list it was sent, and the server works the same thing out
-- again from the position it moved the car to. Two answers to one question is
-- not duplication -- the client's is what you can SEE, and it has to be
-- instant; the server's is what is TRUE, and it is the one that counts. A
-- prompt that lied would be a button that fails, and the server's refusal
-- carries the reason.
--
-- WHY R. E is the dispatch claim and it has to stay free -- pulling up at a
-- fire station and pressing the respond key should still respond. R is next to
-- it, unused by driving, and not Roblox's.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local UserInputService = game:GetService("UserInputService")

local player = Players.LocalPlayer
local Shared = ReplicatedStorage:WaitForChild("Shared")
local Roles = require(Shared:WaitForChild("Roles"))
local ClientBus = require(Shared:WaitForChild("ClientBus"))
local PlayerCar = require(Shared:WaitForChild("PlayerCar"))
local Loc = require(Shared:WaitForChild("Loc"))
local Hud = require(Shared:WaitForChild("Hud"))
local Meta = require(ReplicatedStorage:WaitForChild("CityVisual"):WaitForChild("CityMeta"))

local Audio = (function()
	local ok, m = pcall(require, Shared:WaitForChild("Audio"))
	if ok then
		return m
	end
	return { shot = function() end }
end)()

local Remotes = ReplicatedStorage:WaitForChild("Remotes")
local SignOn = Remotes:WaitForChild("SignOn") :: RemoteFunction
local RoleState = Remotes:WaitForChild("RoleState") :: RemoteEvent

local S = Meta.studsPerMetre
-- The same 22 m RoleService uses. Kept as its own constant rather than shared
-- through a module because the two are allowed to differ: if the prompt were
-- ever tighter than the server's range that would be a fair design choice, and
-- if it were looser it would be a bug. Equal is the honest default.
local RANGE = 22 * S
local RANGE_SQ = RANGE * RANGE

-- The palette is Shared/Hud's now; these two are kept as short local names
-- because this file names a colour on nearly every line of its layout.
local INK = Hud.INK
local DIM = Hud.DIM

-- ---------------------------------------------------------------- the screen

local gui = Instance.new("ScreenGui")
gui.Name = "Shift"
gui.ResetOnSpawn = false
gui.IgnoreGuiInset = true
gui.DisplayOrder = 20
gui.Parent = player:WaitForChild("PlayerGui")

-- THE CARD sits above the dispatch card and the wallet, in the bottom-left
-- stack. Everything the player reads about what they are doing is in one place
-- and this is the top line of it: the shift is the thing every other line is
-- conditional on.
--
-- IT WAS A 150x26 CHIP WITH ONE WORD ON IT. It says the same thing now with a
-- face and a name beside it, which is what every driving game on the platform
-- puts on screen and what this one had nowhere at all: there was no way to tell
-- from a screenshot of this game whose car you were looking at.
--
-- THE FACE COSTS NO WEB CALL. `rbxthumb://` is resolved by the engine's own
-- thumbnail pipeline from an ImageLabel's Image property -- no
-- Players:GetUserThumbnailAsync, no yield, nothing to fail on a slow join and
-- leave the card half-built. A client that cannot fetch it shows an empty
-- rounded square, which is exactly what it showed before this line existed.
local card = Hud.panel(gui, "Shift", Hud.R_CARD)
card.Size = UDim2.fromOffset(214, 54)
-- ON A PHONE IT MOVES TO THE TOP LEFT, just under Roblox's own buttons, with
-- the wallet beside it rather than under it. The bottom-left corner on a touch
-- build is holding the dispatch card and a steering pad and has no room for a
-- third thing -- a phone held sideways is under 400 px tall, and the stack this
-- card sits on top of on a desktop is 230 px of that before the pads are drawn.
-- See DispatchUI's own note on the wallet, which follows this card.
--
-- 52 rather than 36: the top bar is 36 and sitting flush under it reads as part
-- of it.
card.Position = if Hud.thumbs then UDim2.new(0, 18, 0, 52) else UDim2.new(0, 18, 1, -254)

local avatar = Instance.new("ImageLabel")
avatar.Name = "Face"
avatar.Size = UDim2.fromOffset(38, 38)
avatar.Position = UDim2.fromOffset(8, 8)
avatar.BackgroundColor3 = Color3.fromRGB(38, 42, 52)
avatar.BorderSizePixel = 0
avatar.Image = ("rbxthumb://type=AvatarHeadShot&id=%d&w=48&h=48"):format(player.UserId)
Hud.round(avatar, 12)
avatar.Parent = card

-- THE SHIFT'S COLOUR, ON THE FACE'S OWN EDGE. One ring rather than the old
-- separate stripe: the colour belongs to the person on the shift, and drawing
-- it around them says that in a way a bar floating beside them did not.
local ring = Hud.stroke(avatar, Color3.fromRGB(255, 79, 216), 2, 0)

local nameText = Instance.new("TextLabel")
nameText.Name = "Name"
nameText.BackgroundTransparency = 1
nameText.Position = UDim2.fromOffset(54, 8)
nameText.Size = UDim2.new(1, -62, 0, 18)
nameText.Font = Enum.Font.GothamBold
nameText.TextSize = 14
nameText.TextColor3 = INK
nameText.TextXAlignment = Enum.TextXAlignment.Left
nameText.TextTruncate = Enum.TextTruncate.AtEnd
nameText.Text = player.DisplayName
nameText.Parent = card

local chipText = Instance.new("TextLabel")
chipText.Name = "Shift"
chipText.BackgroundTransparency = 1
chipText.Position = UDim2.fromOffset(54, 28)
chipText.Size = UDim2.new(1, -62, 0, 16)
chipText.Font = Enum.Font.GothamBold
chipText.TextSize = 12
chipText.TextColor3 = INK
chipText.TextXAlignment = Enum.TextXAlignment.Left
chipText.TextTruncate = Enum.TextTruncate.AtEnd
chipText.Text = Loc.get(Roles.get(Roles.DEFAULT).title)
chipText.Parent = card

-- THE PROMPT, centred low. Not in the bottom-left stack on purpose: it is
-- transient and it is about where you are rather than what you are doing, so it
-- belongs where your eyes are -- the middle of the road ahead -- rather than in
-- the corner you glance at.
local prompt = Hud.panel(gui, "Prompt", Hud.R_CARD)
-- CLEAR OF THE STACK, NOT JUST CLEAR OF THE BOTTOM EDGE. At -140 this sat in
-- the same horizontal band as the dispatch card (which ends 152 px up) and only
-- missed it because a wide window put 100 px of gap between the two columns --
-- narrow the window and the prompt overlapped the card's right edge. -252 puts
-- its bottom 38 px above the card's top, so the two cannot meet at any width,
-- and it also clears the speedometer's new 62 px housing at the bottom centre.
--
-- ON A PHONE it stays bottom centre and narrows to 300, which is the width
-- that fits between the steering pads on the left and the brake on the right at
-- 800 px across -- the narrowest screen this is laid out for. It sits at -140,
-- which is above the speedometer and below the dispatch card's own lifted
-- position, in the one horizontal band on a touch build with nothing in it.
prompt.Size = if Hud.thumbs then UDim2.fromOffset(300, 62) else UDim2.fromOffset(360, 62)
prompt.Position = if Hud.thumbs then UDim2.new(0.5, -150, 1, -140) else UDim2.new(0.5, -180, 1, -252)
prompt.Visible = false

local key = Instance.new("TextLabel")
key.Size = UDim2.fromOffset(30, 30)
key.Position = UDim2.new(0, 14, 0, 16)
key.BackgroundColor3 = Color3.fromRGB(46, 50, 58)
key.BorderSizePixel = 0
key.Font = Enum.Font.GothamBold
key.Text = "R"
key.TextSize = 14
key.TextColor3 = INK
key.Parent = prompt
Hud.round(key, 9)

local function line(y: number, size: number, colour: Color3, font: Enum.Font): TextLabel
	local t = Instance.new("TextLabel")
	t.BackgroundTransparency = 1
	t.Position = UDim2.new(0, 52, 0, y)
	t.Size = UDim2.new(1, -66, 0, size + 4)
	t.Font = font
	t.TextSize = size
	t.TextColor3 = colour
	t.TextXAlignment = Enum.TextXAlignment.Left
	t.TextTruncate = Enum.TextTruncate.AtEnd
	t.Text = ""
	t.Parent = prompt
	return t
end

local promptTitle = line(10, 15, INK, Enum.Font.GothamMedium)
local promptSub = line(32, 12, DIM, Enum.Font.Gotham)

-- ---------------------------------------------------------------- the state

local depots: { { kind: string, role: string, x: number, z: number, gx: number?, gz: number?, name: string } } = {}
local role = Roles.DEFAULT
local offer: string? = nil
local offerName = ""
local asking = false

local function paintChip()
	local r = Roles.get(role)
	local colour = r.colour or Color3.fromRGB(255, 79, 216)
	chipText.Text = Loc.get(r.title)
	-- THE SHIFT'S NAME IN THE SHIFT'S OWN COLOUR, not white beside a coloured
	-- bar. Two places wearing one colour is what ties the face on this card to
	-- the beacon on the roof and the blips on both maps -- see IncidentTypes'
	-- own note on why the palette lives in one table.
	chipText.TextColor3 = colour
	ring.Color = colour
end

RoleState.OnClientEvent:Connect(function(msg)
	if type(msg) ~= "table" then
		return
	end
	role = msg.role or Roles.DEFAULT
	depots = msg.depots or {}
	ClientBus.role = role
	ClientBus.playable = msg.playable or {}
	ClientBus.depots = depots
	ClientBus.roleChanged:Fire(role)
	paintChip()
end)

paintChip()

-- ---------------------------------------------------------------- the offer

-- WHAT IS ON OFFER WHERE THE CAR IS STOPPED. Both the depot and its gate count,
-- because a fire station sits back in its own yard -- 51 m from the nearest
-- road, on this district's one station -- and a range that reached the building
-- from the street would reach half the street from anywhere.
--
-- Standing at the depot you already work for offers the way out, which is
-- RoleService.offerAt's rule and has to be the same rule here or the prompt and
-- the claim disagree at exactly the place you press the button.
local function offerAt(x: number, z: number): (string?, string)
	for _, d in depots do
		local dx, dz = d.x - x, d.z - z
		local near = dx * dx + dz * dz <= RANGE_SQ
		if not near and d.gx then
			local gx, gz = (d.gx :: number) - x, (d.gz :: number) - z
			near = gx * gx + gz * gz <= RANGE_SQ
		end
		if near then
			if d.role == role then
				return Roles.DEFAULT, d.name
			end
			return d.role, d.name
		end
	end
	return nil, ""
end

-- The refusal holds the second line for long enough to read it. Without the
-- latch the tick below rewrites it as soon as anything changes, and the reason
-- the button did not work is the one thing on this panel worth reading.
local sayUntil = 0

local function ask()
	local want = offer
	if asking or not want then
		return
	end
	asking = true
	local ok, why = SignOn:InvokeServer(want)
	if ok then
		Audio.shot("click", nil, 0.5, 1.2)
	else
		promptSub.Text = Loc.get("roleui.refused"):format(Loc.get(tostring(why)))
		promptSub.TextColor3 = Color3.fromRGB(232, 116, 108)
		sayUntil = os.clock() + 2.5
		Audio.shot("click", nil, 0.35, 0.6)
	end
	asking = false
end

UserInputService.InputBegan:Connect(function(input, processed)
	if processed then
		return
	end
	if input.KeyCode == Enum.KeyCode.R then
		ask()
	end
end)

-- Tapping the prompt does the same thing, because a key hint is not a control
-- on a phone and the prompt is the only affordance on screen at that moment.
local tap = Instance.new("TextButton")
tap.Size = UDim2.fromScale(1, 1)
tap.BackgroundTransparency = 1
tap.Text = ""
tap.Parent = prompt
tap.Activated:Connect(ask)

-- ---------------------------------------------------------------- the car

-- THE HANDLING, applied where the vehicle model runs. The server dressed the
-- car; these are the numbers behind the shape, and they are the reason an
-- appliance feels like one -- 0.62 acceleration on eight tonnes of pump, and a
-- top speed that does not pretend a ladder truck is a hatchback.
--
-- Driven off the model's attribute rather than off RoleState, because the car
-- is the thing being changed and the attribute arrives with it. A client that
-- joins to find somebody else already on a shift is not this script's business;
-- a client whose OWN car has been redressed is.
local VehicleModel = require(Shared:WaitForChild("VehicleModel"))

-- WANTED AND APPLIED, kept apart on purpose. The attribute can arrive before
-- VehicleController has built the local car -- the server's model replicates on
-- its own schedule and the client's simulation starts on its own -- and an
-- applyRole that found no car and gave up would leave a firefighter driving a
-- hatchback for the rest of the session. So the wanted role is remembered and
-- the tick below applies it as soon as there is something to apply it to.
local wantRole = Roles.DEFAULT
local appliedRole: string? = nil

local function applyRole()
	local car = PlayerCar.car
	if not car or appliedRole == wantRole then
		return
	end
	local r = Roles.get(wantRole)
	car.maxSpeed = VehicleModel.TOP_SPEED * r.speed
	car.accel = 40 * r.accel
	car.l = if r.body then r.body.l else 4.5
	car.w = if r.body then r.body.w else 2.0
	-- THE APPLIANCE GOES WHERE THE FIRE IS. Without this the last thirty metres
	-- to a burning building are a forecourt crawl, which is the report the
	-- browser acted on twice.
	car.offroad = r.offroad
	appliedRole = wantRole
end

task.spawn(function()
	local cars = workspace:WaitForChild("Cars")
	local model = cars:WaitForChild("Car_" .. player.UserId, 30)
	if not model then
		return
	end
	wantRole = tostring(model:GetAttribute("Role") or Roles.DEFAULT)
	model:GetAttributeChangedSignal("Role"):Connect(function()
		wantRole = tostring(model:GetAttribute("Role") or Roles.DEFAULT)
	end)

	-- THE BEACON, animated here because CarBuild builds and does not run. Lit
	-- only while there is somewhere to be -- a blue light that is always on says
	-- nothing about whether you are responding, which is the one thing it is
	-- for. DispatchUI owns "am I responding" and publishes it on the bus.
	local t = 0
	RunService.Heartbeat:Connect(function(dt)
		t += dt
		local on = ClientBus.responding == true
		-- Two flashes and a gap, which is what a strobe actually does and what
		-- makes it read as one rather than as a blinking bulb.
		local ph = (t * 2.4) % 1
		local lit = on and (ph < 0.09 or (ph > 0.16 and ph < 0.25))
		-- BOTH LAMPS, same clock -- CarBuild now builds a blue one and a red
		-- one (see its own comment on markings()) rather than one part in a
		-- single fixed colour, so both get toggled here rather than one.
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
	end)
end)

-- ---------------------------------------------------------------- the frame

-- TWENTY TIMES A SECOND, not sixty. This is a scan over twenty-seven depots
-- plus some string formatting, and none of it changes fast enough to be worth
-- a frame -- the car covers two metres between ticks at full speed.
local acc = 0
RunService.Heartbeat:Connect(function(dt)
	acc += dt
	if acc < 0.05 then
		return
	end
	acc = 0

	local car = PlayerCar.car
	if not car then
		prompt.Visible = false
		return
	end
	applyRole()

	local nextOffer, name = offerAt(car.x * S, car.y * S)
	local moved = nextOffer ~= offer or name ~= offerName
	offer, offerName = nextOffer, name
	-- Repainted when the offer changes, and again when a refusal expires -- the
	-- second is what puts the depot's name back after the reason has been read.
	if offer and (moved or (sayUntil > 0 and os.clock() > sayUntil)) then
		if not moved then
			sayUntil = 0
		end
		local r = Roles.get(offer)
		promptTitle.Text = Loc.get("roleui.signOn"):format(Loc.get(r.title))
		promptSub.Text = if name ~= "" then name else Loc.get(r.blurb)
		promptSub.TextColor3 = DIM
		key.BackgroundColor3 = (r.colour or Color3.fromRGB(255, 79, 216)):Lerp(Color3.new(0, 0, 0), 0.45)
	end
	prompt.Visible = offer ~= nil
end)

