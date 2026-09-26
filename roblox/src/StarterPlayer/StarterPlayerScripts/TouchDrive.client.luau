--!strict
-- THE CAR, DRIVEABLE WITH THUMBS.
--
-- Until this file the Roblox port read a keyboard and a gamepad and nothing
-- else (VehicleController's readInput), which on a phone means a city you can
-- look at and cannot drive. Roblox's own touch controls are not an answer
-- either: they steer a HUMANOID, and this car is a kinematic model with no
-- humanoid in it, so the platform has nothing to offer here.
--
-- THE LAYOUT IS THE ONE EVERY DRIVING GAME ON THE PLATFORM USES, because it is
-- the one that fits a pair of thumbs: steering under the left one, throttle and
-- brake under the right, handbrake within reach of the right thumb without
-- leaving the throttle. The browser game's own on-screen pads sit the same way
-- round (js/io.js's stick and pedals), and a player who has played that one
-- should not have to relearn this one.
--
-- WHAT IT WRITES, and nothing else: ClientBus.touch.steer/gas/brake/hand.
-- VehicleController folds that into the same input table a key press makes. No
-- remote, no stepping the car from here, nothing this script can get wrong that
-- is worse than a pad that does not answer.
--
-- WHY THE RELEASE IS TRACKED PER InputObject rather than per button: a thumb
-- that slides off the throttle while still on the glass does not fire the
-- button's own InputEnded in every case, and a throttle that sticks on is the
-- worst bug this file could have. UserInputService.InputEnded fires for the
-- input itself wherever it ends, so remembering which input pressed which pad
-- makes the release unconditional.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local UserInputService = game:GetService("UserInputService")

-- A TOUCHSCREEN AND NO KEYBOARD. A laptop with a touchscreen reports
-- TouchEnabled true and has a keyboard to drive with, and putting pads over its
-- screen would take up a third of it for nothing -- the same test the browser
-- game's own `touchUI` makes before it shows its stick.
if not UserInputService.TouchEnabled or UserInputService.KeyboardEnabled then
	return
end

local player = Players.LocalPlayer
local Shared = ReplicatedStorage:WaitForChild("Shared")
local ClientBus = require(Shared:WaitForChild("ClientBus"))
local Hud = require(Shared:WaitForChild("Hud"))
local Loc = require(Shared:WaitForChild("Loc"))

local gui = Instance.new("ScreenGui")
gui.Name = "Drive"
gui.ResetOnSpawn = false
gui.IgnoreGuiInset = true
-- OVER the speedometer, UNDER the sign-on prompt and the big map. A pad you
-- cannot press because a panel is sitting on it is not a control.
gui.DisplayOrder = 12
gui.Parent = player:WaitForChild("PlayerGui")

-- ---------------------------------------------------------------- the press

-- Which pad each live touch is holding, so its release can be found from the
-- input rather than from whatever is under the finger when it lifts.
local releasing: { [InputObject]: () -> () } = {}

UserInputService.InputEnded:Connect(function(input)
	local done = releasing[input]
	if done then
		releasing[input] = nil
		done()
	end
end)

-- PRESSED AND LIT, in one place. `set` is what the pad does to the bus; the
-- transparency change is the only feedback a glass button can give, and without
-- it there is no way to tell a pad that is not answering from a car that is not
-- moving.
local PRESSED_T = 0.02

local function hold(button: TextButton, set: (number) -> ())
	local function down()
		set(1)
		button.BackgroundTransparency = PRESSED_T
	end
	local function up()
		set(0)
		button.BackgroundTransparency = Hud.PANEL_T
	end

	button.InputBegan:Connect(function(input)
		if input.UserInputType ~= Enum.UserInputType.Touch and input.UserInputType ~= Enum.UserInputType.MouseButton1 then
			return
		end
		releasing[input] = up
		down()
	end)

	-- The button's own release as well as the global one. Whichever arrives
	-- first wins; `up` is idempotent, so the second is free.
	button.InputEnded:Connect(function(input)
		if input.UserInputType ~= Enum.UserInputType.Touch and input.UserInputType ~= Enum.UserInputType.MouseButton1 then
			return
		end
		releasing[input] = nil
		up()
	end)
end

-- ---------------------------------------------------------------- the pads

-- Sized for a thumb, not for a mouse: 84 px is comfortably past the 44 pt
-- minimum tap target on every phone this will run on, and the steering pads are
-- the two the thumb never leaves.
local PAD = 84
local BIG = 92
local SMALL = 68
local EDGE = 22

local function pad(name: string, glyph: string, caption: string, size: number, anchor: Vector2, pos: UDim2): TextButton
	local b = Hud.tile(gui, name, glyph, caption, size)
	b.AnchorPoint = anchor
	b.Position = pos
	return b
end

-- ---- left thumb: steering ----

local left = pad("Left", "◀", "", PAD, Vector2.new(0, 1), UDim2.new(0, EDGE, 1, -EDGE))
local right = pad("Right", "▶", "", PAD, Vector2.new(0, 1), UDim2.new(0, EDGE + PAD + 12, 1, -EDGE))

-- STEER IS A SUM, NOT A LAST-PRESS. Both pads held at once is a wheel held
-- straight, which is what a player who is rolling their thumb across the gap
-- between them means -- and it is the only reading that cannot leave the wheel
-- locked over when one of the two releases late.
local steerL, steerR = 0, 0
local function writeSteer()
	ClientBus.touch.steer = steerR - steerL
end
hold(left, function(v)
	steerL = v
	writeSteer()
end)
hold(right, function(v)
	steerR = v
	writeSteer()
end)

-- ---- right thumb: throttle, brake, handbrake ----

local gas = pad("Gas", "▲", Loc.get("drive.gas"), BIG, Vector2.new(1, 1), UDim2.new(1, -EDGE, 1, -EDGE))
local brake = pad("Brake", "▼", Loc.get("drive.brake"), PAD, Vector2.new(1, 1), UDim2.new(1, -EDGE - BIG - 12, 1, -EDGE))
local hand = pad("Hand", "✋", Loc.get("drive.hand"), SMALL, Vector2.new(1, 1), UDim2.new(1, -EDGE, 1, -EDGE - BIG - 12))

hold(gas, function(v)
	ClientBus.touch.gas = v
end)
hold(brake, function(v)
	ClientBus.touch.brake = v
end)
hold(hand, function(v)
	ClientBus.touch.hand = v
end)

-- THE HANDBRAKE IS THE ONE THAT SHOULD LOOK LIKE A CONTROL RATHER THAN A HINT.
-- It is the smallest pad and the one a new player has no reason to guess at, so
-- it wears the shift's own accent instead of the panel's grey.
local handGlyph = hand:FindFirstChild("Glyph")
if handGlyph and handGlyph:IsA("TextLabel") then
	handGlyph.TextColor3 = Hud.WARN
end
