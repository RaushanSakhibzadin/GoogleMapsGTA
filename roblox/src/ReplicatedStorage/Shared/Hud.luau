--!strict
-- ONE LOOK FOR EVERY PANEL ON SCREEN.
--
-- Before this file each client script invented its own card: the dispatch card
-- was a 6 px corner at transparency 0.15, the shift chip a 4 px corner at the
-- same colour, the sign-on prompt a third radius again, and none of them had an
-- edge. Four scripts each deciding what "a panel" looks like is four answers to
-- one question, and they had already drifted apart.
--
-- So the vocabulary lives here and the scripts ask for it:
--
--   · PANEL/INK/DIM/MONEY -- the palette, named by what it is for
--   · round/stroke        -- the two things every surface in this UI has
--   · panel/pill/tile     -- the three shapes it comes in
--   · money               -- $1,204, because a wallet with no thousands
--                            separator is four digits you have to count
--
-- THE SHAPE IT IS AIMING AT is a modern Roblox driving HUD: dark translucent
-- surfaces with a generous corner radius and a single hairline edge, glyph over
-- caption on anything tappable, and nothing carrying a border or a gradient
-- that is not doing work. A big radius and a hairline are most of it -- they
-- are what separates a control from a debug label.
--
-- NOTHING HERE TOUCHES LAYOUT. Position and size stay with the script that owns
-- the widget, because where a card sits is a decision about that card's
-- neighbours and this file cannot see them.

local RunService = game:GetService("RunService")

local Hud = {}

-- ---------------------------------------------------------------- the shape
--                                                                  of the screen

-- WHETHER THE PLAYER IS DRIVING WITH THUMBS, answered once, in the one place
-- every HUD script already asks something of.
--
-- It is here and not in ClientBus because ORDER MATTERS and a module has none:
-- TouchDrive writes ClientBus.touch, but the three scripts that have to lay
-- themselves out around its pads are required at the same moment it is and
-- cannot wait to be told. A module-scope constant is computed the first time
-- anything requires this file and reads the same for everybody afterwards.
--
-- A TOUCHSCREEN AND NO KEYBOARD -- the same test TouchDrive makes before it
-- draws anything, and it has to stay the same test: the pads and the space left
-- for them are two halves of one decision.
--
-- GUARDED ON IsClient because UserInputService does not exist on a server, and
-- nothing stops a server script requiring this file for Hud.money one day.
Hud.thumbs = false
if RunService:IsClient() then
	local UserInputService = game:GetService("UserInputService")
	Hud.thumbs = UserInputService.TouchEnabled and not UserInputService.KeyboardEnabled
end

-- HOW FAR THE BOTTOM-LEFT STACK HAS TO GET OUT OF THE WAY. The steering pads
-- are 84 px tall sitting 22 px off the bottom edge, so they own the lowest
-- 106 px of both bottom corners. 124 rather than the 112 that just clears
-- them: the sign-on prompt has to fit BETWEEN the dispatch card and the
-- speedometer, and at 112 there were sixty pixels of gap for a sixty-two pixel
-- panel. Zero on a keyboard, where nothing is drawn down there at all and the
-- stack stays exactly where it has always been.
Hud.PAD_LIFT = if Hud.thumbs then 124 else 0

-- ---------------------------------------------------------------- the palette

Hud.INK = Color3.fromRGB(240, 242, 246) -- anything you are meant to read
Hud.DIM = Color3.fromRGB(154, 161, 173) -- the second line, the caption, the unit
Hud.PANEL = Color3.fromRGB(19, 21, 27) -- every surface, at PANEL_T
Hud.MONEY = Color3.fromRGB(92, 230, 128) -- the wallet, and only the wallet
Hud.WARN = Color3.fromRGB(255, 186, 72)
Hud.HOT = Color3.fromRGB(255, 92, 96)
Hud.EDGE = Color3.fromRGB(255, 255, 255) -- the hairline, at EDGE_T

Hud.PANEL_T = 0.22
Hud.EDGE_T = 0.86

-- A control is rounder than a card is rounder than a chip. Three numbers rather
-- than one so a 40 px chip does not come out a capsule and a 130 px card does
-- not come out a rectangle with the corners nibbled.
Hud.R_CHIP = 10
Hud.R_CARD = 16
Hud.R_TILE = 18

-- ---------------------------------------------------------------- primitives

function Hud.round(inst: GuiObject, radius: number?): UICorner
	local c = Instance.new("UICorner")
	c.CornerRadius = UDim.new(0, radius or Hud.R_CARD)
	c.Parent = inst
	return c
end

function Hud.pillRound(inst: GuiObject): UICorner
	local c = Instance.new("UICorner")
	c.CornerRadius = UDim.new(1, 0)
	c.Parent = inst
	return c
end

-- APPLYBORDER, NOT CONTEXTUAL. A hairline drawn INSIDE the shape rather than
-- around it, because Border is the default and it lands outside the corner
-- radius -- which is exactly the look this file exists to get rid of.
function Hud.stroke(inst: GuiObject, colour: Color3?, thickness: number?, transparency: number?): UIStroke
	local s = Instance.new("UIStroke")
	s.Color = colour or Hud.EDGE
	s.Thickness = thickness or 1
	s.Transparency = transparency or Hud.EDGE_T
	s.ApplyStrokeMode = Enum.ApplyStrokeMode.Border
	s.Parent = inst
	return s
end

-- ---------------------------------------------------------------- surfaces

-- The card, the prompt, the speedometer housing: anything that holds text.
function Hud.panel(parent: Instance, name: string, radius: number?): Frame
	local f = Instance.new("Frame")
	f.Name = name
	f.BackgroundColor3 = Hud.PANEL
	f.BackgroundTransparency = Hud.PANEL_T
	f.BorderSizePixel = 0
	Hud.round(f, radius or Hud.R_CARD)
	Hud.stroke(f)
	f.Parent = parent
	return f
end

-- A capsule with one line in it -- the wallet, a badge, a readout. `colour` is
-- the TEXT's colour; the capsule itself is always the panel colour, so a green
-- number reads as a number that is green rather than as a green button.
function Hud.pill(parent: Instance, name: string, colour: Color3, size: number): (Frame, TextLabel)
	local f = Instance.new("Frame")
	f.Name = name
	f.BackgroundColor3 = Hud.PANEL
	f.BackgroundTransparency = Hud.PANEL_T
	f.BorderSizePixel = 0
	Hud.pillRound(f)
	Hud.stroke(f)
	f.Parent = parent

	local t = Instance.new("TextLabel")
	t.Name = "Text"
	t.BackgroundTransparency = 1
	t.Size = UDim2.new(1, -24, 1, 0)
	t.Position = UDim2.fromOffset(12, 0)
	t.Font = Enum.Font.GothamBold
	t.TextSize = size
	t.TextColor3 = colour
	t.TextXAlignment = Enum.TextXAlignment.Left
	t.Text = ""
	t.Parent = f

	return f, t
end

-- THE TAPPABLE SQUARE: a big glyph with a small caption under it. This is the
-- shape every on-screen control in the game is -- a steering pad, a throttle, a
-- handbrake -- and the caption is what stops a glyph having to carry the whole
-- meaning on its own.
--
-- `caption` may be "": a steering arrow needs no label and the glyph centres
-- itself when there is nothing under it.
function Hud.tile(parent: Instance, name: string, glyph: string, caption: string, size: number): TextButton
	local b = Instance.new("TextButton")
	b.Name = name
	b.Size = UDim2.fromOffset(size, size)
	b.BackgroundColor3 = Hud.PANEL
	b.BackgroundTransparency = Hud.PANEL_T
	b.BorderSizePixel = 0
	b.AutoButtonColor = false
	b.Text = ""
	Hud.round(b, Hud.R_TILE)
	Hud.stroke(b)
	b.Parent = parent

	local hasCaption = caption ~= ""

	local g = Instance.new("TextLabel")
	g.Name = "Glyph"
	g.BackgroundTransparency = 1
	g.Size = UDim2.new(1, 0, if hasCaption then 0.66 else 1, 0)
	g.Position = UDim2.fromScale(0, if hasCaption then 0.06 else 0)
	g.Font = Enum.Font.GothamBold
	g.TextSize = math.floor(size * (if hasCaption then 0.42 else 0.52))
	g.TextColor3 = Hud.INK
	g.Text = glyph
	g.Parent = b

	if hasCaption then
		local c = Instance.new("TextLabel")
		c.Name = "Caption"
		c.BackgroundTransparency = 1
		c.Size = UDim2.new(1, 0, 0.26, 0)
		c.Position = UDim2.fromScale(0, 0.68)
		c.Font = Enum.Font.GothamBold
		c.TextSize = math.max(9, math.floor(size * 0.15))
		c.TextColor3 = Hud.DIM
		c.Text = caption
		c.Parent = b
	end

	return b
end

-- ---------------------------------------------------------------- numbers

-- $1,204 RATHER THAN $1204. Four digits with no group separator is a number you
-- read by counting, which is the one thing a glanceable HUD cannot ask for.
--
-- The loop is the standard right-to-left regroup: `gsub` walks the string
-- inserting a comma before every run of three that still has a digit in front
-- of it, and repeats until it stops changing -- one pass only reaches the first
-- group.
function Hud.money(amount: number): string
	local s = tostring(math.floor(math.abs(amount)))
	while true do
		local grouped, hits = s:gsub("^(%d+)(%d%d%d)", "%1,%2")
		s = grouped
		if hits == 0 then
			break
		end
	end
	return (if amount < 0 then "-$" else "$") .. s
end

-- THE SPEED'S OWN COLOUR, shared by the readout and its bar so the two cannot
-- disagree. White until you are moving properly, amber through the middle of
-- the range, red at the top -- the same green/amber/red banding the armour bar
-- already uses, minus the green, because "slow" is not a warning.
function Hud.speedColour(fraction: number): Color3
	if fraction < 0.45 then
		return Hud.INK
	elseif fraction < 0.78 then
		return Hud.WARN
	end
	return Hud.HOT
end

return Hud
