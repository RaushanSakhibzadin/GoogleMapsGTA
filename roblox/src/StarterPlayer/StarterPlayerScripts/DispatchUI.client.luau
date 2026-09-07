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

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local UserInputService = game:GetService("UserInputService")

local player = Players.LocalPlayer
local Remotes = ReplicatedStorage:WaitForChild("Remotes")
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
card.Position = UDim2.new(0, 18, 1, -146)
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

local wallet = label(gui, UDim2.new(0, 200, 0, 22), UDim2.new(0, 18, 0, 14), "$0", 20, Color3.fromRGB(238, 240, 244))

-- ---------------------------------------------------------------- the marker

local beam = Instance.new("Part")
beam.Name = "IncidentMarker"
beam.Anchored = true
beam.CanCollide = false
beam.CanQuery = false
beam.CanTouch = false
beam.CastShadow = false
beam.Material = Enum.Material.Neon
beam.Color = Color3.fromRGB(255, 140, 40)
beam.Transparency = 0.35
beam.Size = Vector3.new(6, 400, 6)
beam.Parent = workspace

-- ---------------------------------------------------------------- state

Wallet.OnClientEvent:Connect(function(n)
	money = n
	wallet.Text = "$" .. tostring(n)
end)

Board.OnClientEvent:Connect(function(list)
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
	else
		status.Text = "DISPATCH: " .. tostring(why)
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

	if not inc then
		card.Visible = false
		beam.Transparency = 1
		mine = nil
		return
	end
	card.Visible = true

	-- If the board no longer lists the one I was on, it resolved or expired.
	if mine and inc.id ~= mine then
		mine = nil
	end

	beam.Transparency = 0.35
	beam.Position = Vector3.new(inc.x, 200, inc.z)

	title.Text = inc.label
	detail.Text = inc.detail .. (if inc.name ~= "" then "  ·  " .. inc.name else "")
	fill.Size = UDim2.new(math.clamp(inc.progress, 0, 1), 0, 1, 0)

	local d = if from then (Vector2.new(inc.x, inc.z) - Vector2.new(from.X, from.Z)).Magnitude else 0
	local metres = math.floor(d / 3)

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
