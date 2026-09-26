--!strict
-- HOW FAST YOU ARE GOING, which the port has never said out loud.
--
-- The browser game has had a speedometer since the beginning (js/render.js's
-- own #spd readout above КМ/Ч); this port shipped without one, so the only
-- feedback on speed was the engine note and how quickly the buildings went
-- past. That is enough to drive by and not enough to drive WELL by -- "am I
-- going to make this corner" is a number, and every driving game on the
-- platform puts it in the same place: bottom centre, big, under the car.
--
-- READ-ONLY, AND OFF THE SAME CAR EVERYTHING ELSE READS. Shared/PlayerCar is
-- the car VehicleController integrates; this takes the magnitude of its
-- velocity and writes a label. Nothing here can affect the driving, which is
-- the point -- a HUD that can change the simulation is a HUD that can break it.
--
-- THE BAR IS THE SAME NUMBER AS THE DIGITS, not a second opinion: both come
-- from `frac`, the fraction of the car's own top speed, so the colour the
-- digits turn and the point the bar reaches always agree. `car.maxSpeed` and
-- not a constant, because a fire appliance's ceiling is not a hatchback's --
-- Shift/RoleUI rewrites it when you sign on, and a bar measured against a
-- number the car cannot reach would never fill.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local player = Players.LocalPlayer
local Shared = ReplicatedStorage:WaitForChild("Shared")
local PlayerCar = require(Shared:WaitForChild("PlayerCar"))
local VehicleModel = require(Shared:WaitForChild("VehicleModel"))
local Hud = require(Shared:WaitForChild("Hud"))
local Loc = require(Shared:WaitForChild("Loc"))

local W, H = 168, 62

local gui = Instance.new("ScreenGui")
gui.Name = "Speedo"
gui.ResetOnSpawn = false
gui.IgnoreGuiInset = true
-- UNDER the sign-on prompt and the dispatch card, over nothing. It is the
-- least urgent thing on screen and must never sit on top of a prompt.
gui.DisplayOrder = 10
gui.Parent = player:WaitForChild("PlayerGui")

local panel = Hud.panel(gui, "Panel", Hud.R_CARD)
panel.AnchorPoint = Vector2.new(0.5, 1)
panel.Position = UDim2.new(0.5, 0, 1, -14)
panel.Size = UDim2.fromOffset(W, H)
panel.Visible = false -- nothing to say until there is a car

-- THE DIGITS, sitting slightly left of centre so the unit can sit beside them
-- rather than under them. Right-aligned, because a number that grows a digit
-- at 100 km/h should grow leftwards into its own whitespace instead of shoving
-- the unit off the panel.
local digits = Instance.new("TextLabel")
digits.Name = "Digits"
digits.BackgroundTransparency = 1
digits.Position = UDim2.fromOffset(0, 4)
digits.Size = UDim2.new(1, -58, 0, 38)
digits.Font = Enum.Font.GothamBlack
digits.TextSize = 34
digits.TextColor3 = Hud.INK
digits.TextXAlignment = Enum.TextXAlignment.Right
digits.Text = "0"
digits.Parent = panel

local unit = Instance.new("TextLabel")
unit.Name = "Unit"
unit.BackgroundTransparency = 1
unit.Position = UDim2.new(1, -52, 0, 17)
unit.Size = UDim2.fromOffset(44, 16)
unit.Font = Enum.Font.GothamBold
unit.TextSize = 12
unit.TextColor3 = Hud.DIM
unit.TextXAlignment = Enum.TextXAlignment.Left
unit.Text = Loc.get("speedo.unit")
unit.Parent = panel

local track = Instance.new("Frame")
track.Name = "Track"
track.Position = UDim2.new(0, 14, 1, -14)
track.Size = UDim2.new(1, -28, 0, 5)
track.BackgroundColor3 = Color3.fromRGB(0, 0, 0)
track.BackgroundTransparency = 0.5
track.BorderSizePixel = 0
Hud.pillRound(track)
track.Parent = panel

local fill = Instance.new("Frame")
fill.Name = "Fill"
fill.Size = UDim2.fromScale(0, 1)
fill.BackgroundColor3 = Hud.INK
fill.BorderSizePixel = 0
Hud.pillRound(fill)
fill.Parent = track

-- TWENTY TIMES A SECOND, not sixty. The digits are integers and the bar is
-- five pixels tall; a third of the frames is more than enough to make both look
-- continuous, and this is a HUD, not the simulation -- the same call
-- Shift/RoleUI's own depot scan already makes for the same reason.
--
-- The value itself is EASED rather than sampled, so a kerb strike does not make
-- the number flicker between two readings a frame apart. 0.35 of the way each
-- tick is about a tenth of a second to settle: fast enough that the number is
-- honest about the throttle, slow enough not to jitter.
local shown = 0
local acc = 0

RunService.Heartbeat:Connect(function(dt)
	acc += dt
	if acc < 0.05 then
		return
	end
	acc = 0

	local car = PlayerCar.get()
	if not car then
		panel.Visible = false
		return
	end
	panel.Visible = true

	local c = car :: any
	local metresPerSecond = math.sqrt(c.vx * c.vx + c.vy * c.vy)
	shown += (metresPerSecond * 3.6 - shown) * 0.35

	local top = (c.maxSpeed or VehicleModel.TOP_SPEED) * 3.6
	local frac = math.clamp(if top > 0 then shown / top else 0, 0, 1)
	local colour = Hud.speedColour(frac)

	digits.Text = tostring(math.floor(shown + 0.5))
	digits.TextColor3 = colour
	fill.Size = UDim2.fromScale(frac, 1)
	fill.BackgroundColor3 = colour
end)
