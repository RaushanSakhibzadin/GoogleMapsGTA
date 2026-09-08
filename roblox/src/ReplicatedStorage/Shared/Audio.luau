--!strict
-- SOUND, WITHOUT UPLOADING ANYTHING.
--
-- THE PROBLEM. Roblox will not play audio that is not an asset, and an asset
-- means Open Cloud, an upload and a moderation pass -- which is the M0 job in
-- ROBLOX_PORT_PLAN.md §6 and is not done. Worse, from where this file was
-- written there is no way to verify that any given asset id exists, is public,
-- or has not been moderated away since: an id here would be a guess, and a
-- wrong guess is silence with no error.
--
-- THE WAY ROUND IT. `rbxasset://` is content shipped INSIDE the Roblox client
-- rather than fetched from the asset service. It needs no upload, no id, no
-- moderation and no network. It is a small and rather odd library -- these are
-- the sounds the engine has carried around for years -- but a low tone you can
-- pitch-shift is an engine, and a click is a click.
--
-- IT IS STILL A GUESS, so it is a CHECKED one. Every slot below is a LIST of
-- candidates, tried in order: each is loaded through ContentProvider and the
-- first that actually arrives is the one that plays. A slot where nothing loads
-- goes silent and says so once in the output, and every call site carries on
-- as though it had played. Nothing in this game may break because a sound did
-- not.
--
-- SO IF SOMETHING IS SILENT, that is where to look -- the warning names the
-- slot. Put your own uploaded id at the FRONT of that slot's list and it wins;
-- nothing else has to change. That is also the upgrade path when the real audio
-- from §6 is finally uploaded: this table, and nothing else.

local ContentProvider = game:GetService("ContentProvider")
local SoundService = game:GetService("SoundService")

local Audio = {}

-- ---------------------------------------------------------------- the slots

-- Ordered candidates. Put a real asset id ("rbxassetid://...") first to override.
local SLOTS: { [string]: { string } } = {
	-- THE ENGINE IS ONE SUSTAINED SOUND, PITCHED. There is no engine loop in the
	-- client library and no oscillator in Luau, so the engine is whichever of
	-- these lands, with PlaybackSpeed following road speed. It reads as an
	-- engine because it rises and falls with the throttle, not because of its
	-- timbre -- which is the part your ear is actually listening to.
	--
	-- `action_falling` is a rushing wind loop and is the better one if it is
	-- there; a bass note is the fallback.
	engine = {
		"rbxasset://sounds/action_falling.mp3",
		"rbxasset://sounds/bass.wav",
		"rbxasset://sounds/action_swim.mp3",
	},

	-- Something hard, for hitting a building, a car or a person. Scaled by
	-- impact speed and pitched at the call site.
	impact = {
		"rbxasset://sounds/metal.ogg",
		"rbxasset://sounds/impact_water.mp3",
		"rbxasset://sounds/snap.mp3",
		"rbxasset://sounds/hit.wav",
		"rbxasset://sounds/switch3.wav",
	},

	-- The dispatch tones. Short, dry, and used sparingly -- a UI that pings at
	-- you constantly is a UI you turn off.
	ping = {
		"rbxasset://sounds/electronicpingshort.wav",
		"rbxasset://sounds/switch.wav",
		"rbxasset://sounds/clickfast.wav",
	},
	click = {
		"rbxasset://sounds/switch3.wav",
		"rbxasset://sounds/clickfast.wav",
		"rbxasset://sounds/switch.wav",
		"rbxasset://sounds/electronicpingshort.wav",
	},

	-- THE SIREN, and the same trick as the engine: one tone, pitched up and down
	-- on a timer. A two-tone siren is two pitches of one note, which is all this
	-- has to be.
	siren = {
		"rbxasset://sounds/bass.wav",
		"rbxasset://sounds/electronicpingshort.wav",
	},

	-- Fire. Nothing in the library is a crackle, so this is whatever rumbles,
	-- held under the Fire instance's own visual -- it carries distance and
	-- presence rather than texture.
	fire = {
		"rbxasset://sounds/action_falling.mp3",
		"rbxasset://sounds/bass.wav",
		"rbxasset://sounds/action_swim.mp3",
	},
}

-- NO SLOT DEPENDS ON A SINGLE FILE, deliberately. Every path above is a guess:
-- nothing in this repository can list what the Roblox client actually ships, so
-- these are the names that have been in it for years and the probe below finds
-- out which of them are real. Three slots pointing at one file would have meant
-- one wrong guess taking out the engine, the siren and the fire together.

-- ---------------------------------------------------------------- resolving

-- NOTHING HERE EVER YIELDS ITS CALLER, and that is the whole design of this
-- section rather than a nicety.
--
-- Resolving a slot means ContentProvider:PreloadAsync, which yields. The first
-- version simply called it from make(), which is called from a RenderStepped
-- handler when a fire appears -- so the handler yielded mid-frame, and worse,
-- the guard against re-entering returned nil while the first resolution was
-- still in flight. The fire got asked for its sound exactly once, during the
-- window where the answer was "not yet", and was silent for ever after.
--
-- So: a slot is in one of three states, resolution happens on its own thread,
-- and asking for an unresolved slot starts that thread and returns nil this
-- frame. Callers that want a persistent sound retry; callers firing a one-shot
-- simply miss the first one, which nobody has ever noticed.
--
--   nil    not looked at yet
--   false  looked at, nothing loaded -- silent for the rest of the session
--   string the content id that worked
local resolved: { [string]: (string | boolean)? } = {}
local resolving: { [string]: boolean } = {}

local function startResolve(slot: string)
	if resolved[slot] ~= nil or resolving[slot] then
		return
	end
	local list = SLOTS[slot]
	if not list then
		warn("[audio] no such slot: " .. slot)
		resolved[slot] = false
		return
	end
	resolving[slot] = true

	task.spawn(function()
		for _, id in list do
			local probe = Instance.new("Sound")
			probe.SoundId = id
			-- PCALLED, because PreloadAsync throws on a malformed content string
			-- rather than returning a failure -- and a malformed string is
			-- exactly what a guessed rbxasset path is.
			local ok = pcall(function()
				ContentProvider:PreloadAsync({ probe })
			end)
			local loaded = ok and probe.IsLoaded
			probe:Destroy()
			if loaded then
				resolved[slot] = id
				resolving[slot] = nil
				return
			end
		end
		warn(
			("[audio] slot '%s' is silent -- none of its %d candidates loaded. "):format(slot, #list)
				.. "Put a working id at the front of SLOTS."
				.. slot
				.. " in Shared/Audio."
		)
		resolved[slot] = false
		resolving[slot] = nil
	end)
end

-- The id for a slot, or nil. Never yields; starts resolution if it has not
-- happened yet, so the SECOND call is usually the one that succeeds.
local function idOf(slot: string): string?
	local r = resolved[slot]
	if type(r) == "string" then
		return r
	end
	if r == nil then
		startResolve(slot)
	end
	return nil
end

-- "unknown" while it is still being looked at, "silent" once it is known not to
-- work, or the id. A caller that wants a permanent looping sound uses this to
-- know whether to keep retrying or to give up.
function Audio.state(slot: string): string
	local r = resolved[slot]
	if type(r) == "string" then
		return r
	end
	if r == false then
		return "silent"
	end
	startResolve(slot)
	return "unknown"
end

-- Warm every slot up front, so the first gearshift is not the thing that pays
-- for the preload, and so the failures are all logged in one place at boot
-- rather than at whatever moment each sound was first wanted.
function Audio.warm()
	for slot in SLOTS do
		startResolve(slot)
	end
end

-- ---------------------------------------------------------------- playing

-- A Sound that lives as long as the caller wants it to. Parent it to a part and
-- Roblox does the 3D placement and rolloff; parent it to nothing and it is 2D.
--
-- Returns nil when the slot is silent OR not resolved yet, and EVERY CALLER
-- MUST COPE -- that is the whole discipline this file is built on. Guarding at
-- the call site is one `if`; a game that errors because a sound is missing is
-- unshippable. A caller that needs the sound eventually should retry while
-- Audio.state() is still "unknown".
function Audio.make(slot: string, parent: Instance?): Sound?
	local id = idOf(slot)
	if not id then
		return nil
	end
	local s = Instance.new("Sound")
	s.SoundId = id
	s.Parent = parent or SoundService
	return s
end

-- Fire and forget: a one-shot at a position, cleaned up when it finishes.
function Audio.shot(slot: string, at: Vector3?, volume: number?, speed: number?)
	local id = idOf(slot)
	if not id then
		return
	end
	local s = Instance.new("Sound")
	s.SoundId = id
	s.Volume = volume or 0.5
	s.PlaybackSpeed = speed or 1

	if at then
		-- A Sound is only positional if its parent has a position, so a one-shot
		-- in the world gets a speck of a Part to hang off. An Attachment would
		-- do too and is cheaper -- but an Attachment has to be parented to
		-- something that already has a position, and at the moment a car hits a
		-- wall there is no guarantee of a convenient one. A part that exists for
		-- six seconds is simpler than a rule about where to hang the attachment.
		local anchor = Instance.new("Part")
		anchor.Name = "SoundAt"
		anchor.Anchored = true
		anchor.CanCollide = false
		anchor.CanQuery = false
		anchor.CanTouch = false
		anchor.CastShadow = false
		anchor.Transparency = 1
		anchor.Size = Vector3.new(0.05, 0.05, 0.05)
		anchor.CFrame = CFrame.new(at)
		anchor.Parent = workspace

		s.RollOffMaxDistance = 900
		s.RollOffMinDistance = 30
		s.Parent = anchor
		s:Play()
		task.delay(6, function()
			anchor:Destroy()
		end)
	else
		s.Parent = SoundService
		s:Play()
		task.delay(6, function()
			s:Destroy()
		end)
	end
end

return Audio
