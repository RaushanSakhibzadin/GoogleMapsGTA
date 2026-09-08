--!strict
-- CLIENT ERRORS, ON THE SCREEN.
--
-- WHY THIS EXISTS, and it is a workflow reason rather than a game one. Nothing
-- in this repository can execute a line of Luau, so every client-side error
-- costs a round trip through somebody else's screen -- and a screenshot does
-- not contain the Output window. Three separate rounds of this project have
-- been spent on the same conversation:
--
--   "the screen is empty"        -> CityVisual.FlatData indexed before it
--                                   replicated, killing CityVisuals
--   "the car is invisible"       -> no ReplicationFocus
--   "i am in the sky"            -> `SoundGroup.SoundGroup` is not a property,
--                                   which took Audio down and VehicleController,
--                                   DispatchUI, Life and SettingsUI with it
--
-- Every one of those was a single unmistakable line in Output, and every one of
-- them took a round trip to see. The third is what paid for this file.
--
-- ABOVE THE LOADING SCREEN, because the errors that matter most are the ones
-- thrown while it is still up -- a module that fails to load fails during the
-- join, behind an opaque panel.
--
-- IT MUST NOT BECOME THE PROBLEM. Everything here is wrapped, capped and
-- deduplicated: an error inside an error reporter is a loop, and a reporter
-- that stacks two hundred identical messages is a wall of red that hides the
-- one line that mattered.

local Players = game:GetService("Players")
local ScriptContext = game:GetService("ScriptContext")

local MAX_SHOWN = 4

local ok = pcall(function()
	local player = Players.LocalPlayer
	local playerGui = player:WaitForChild("PlayerGui")

	local gui = Instance.new("ScreenGui")
	gui.Name = "Errors"
	gui.ResetOnSpawn = false
	gui.IgnoreGuiInset = true
	gui.DisplayOrder = 1500 -- above the loading screen, which is 1000
	gui.Enabled = false
	gui.Parent = playerGui

	local panel = Instance.new("Frame")
	panel.Size = UDim2.new(0, 560, 0, 0)
	panel.AutomaticSize = Enum.AutomaticSize.Y
	panel.Position = UDim2.new(0.5, -280, 0, 12)
	panel.BackgroundColor3 = Color3.fromRGB(58, 16, 18)
	panel.BackgroundTransparency = 0.08
	panel.BorderSizePixel = 0
	panel.Parent = gui
	local corner = Instance.new("UICorner")
	corner.CornerRadius = UDim.new(0, 6)
	corner.Parent = panel

	local pad = Instance.new("UIPadding")
	pad.PaddingTop = UDim.new(0, 10)
	pad.PaddingBottom = UDim.new(0, 10)
	pad.PaddingLeft = UDim.new(0, 14)
	pad.PaddingRight = UDim.new(0, 40)
	pad.Parent = panel

	local list = Instance.new("UIListLayout")
	list.SortOrder = Enum.SortOrder.LayoutOrder
	list.Padding = UDim.new(0, 4)
	list.Parent = panel

	local head = Instance.new("TextLabel")
	head.BackgroundTransparency = 1
	head.Size = UDim2.new(1, 0, 0, 16)
	head.Font = Enum.Font.GothamMedium
	head.Text = "CLIENT ERROR"
	head.TextSize = 11
	head.TextColor3 = Color3.fromRGB(255, 138, 130)
	head.TextXAlignment = Enum.TextXAlignment.Left
	head.LayoutOrder = 0
	head.Parent = panel

	local dismiss = Instance.new("TextButton")
	dismiss.Size = UDim2.fromOffset(26, 26)
	dismiss.Position = UDim2.new(1, -32, 0, 6)
	dismiss.BackgroundTransparency = 1
	dismiss.Text = "✕"
	dismiss.TextSize = 16
	dismiss.TextColor3 = Color3.fromRGB(255, 170, 164)
	dismiss.Font = Enum.Font.GothamMedium
	dismiss.ZIndex = 3
	dismiss.Parent = gui
	dismiss.Visible = false
	dismiss.Activated:Connect(function()
		gui.Enabled = false
		dismiss.Visible = false
	end)

	local seen: { [string]: boolean } = {}
	local shown = 0

	ScriptContext.Error:Connect(function(message: string, _stack: string, source: Instance?)
		-- DEDUPLICATED BY MESSAGE. A broken module throws once per script that
		-- requires it -- four times, in the case this was written for -- and a
		-- RenderStepped handler that throws does it sixty times a second.
		if seen[message] or shown >= MAX_SHOWN then
			return
		end
		seen[message] = true
		shown += 1

		pcall(function()
			local line = Instance.new("TextLabel")
			line.BackgroundTransparency = 1
			line.Size = UDim2.new(1, 0, 0, 0)
			line.AutomaticSize = Enum.AutomaticSize.Y
			line.Font = Enum.Font.Code
			line.Text = (if source then source.Name .. ": " else "") .. message
			line.TextSize = 13
			line.TextColor3 = Color3.fromRGB(255, 226, 224)
			line.TextXAlignment = Enum.TextXAlignment.Left
			line.TextWrapped = true
			line.LayoutOrder = shown
			line.Parent = panel

			gui.Enabled = true
			dismiss.Visible = true
		end)
	end)
end)

if not ok then
	-- If the reporter cannot start, say so in the one place that always works.
	warn("[errors] on-screen error banner failed to start")
end
