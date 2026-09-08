--!strict
-- SOUND, WITHOUT UPLOADING ANYTHING.
--
-- THE PROBLEM. Roblox will not play audio that is not an asset, and an asset
-- means Open Cloud, an upload and a moderation pass -- the M0 job in
-- ROBLOX_PORT_PLAN.md §6, which is not done. Nothing in this repository can
-- verify that a given asset id exists, is public, or has not been moderated
-- away since, so an id here would be a guess and a wrong guess is silence.
--
-- THE WAY ROUND IT. `rbxasset://` is content shipped INSIDE the Roblox client
-- rather than fetched from the asset service: no upload, no id, no moderation,
-- no network. A low tone you can pitch-shift is an engine, and a click is a
-- click.
--
-- ---------------------------------------------------------------------------
--
-- AND HERE IS THE MISTAKE THE FIRST VERSION MADE, because it is the whole
-- lesson of this file. It tried to be careful: every slot probed its candidates
-- through ContentProvider:PreloadAsync, checked Sound.IsLoaded, and only played
-- the ones that came back loaded. Every single slot reported itself silent:
--
--     [audio] slot 'siren' is silent -- none of its 2 candidates loaded
--     [audio] slot 'engine' is silent -- none of its 3 candidates loaded
--     ... and so on, for all six
--
-- The paths were not the problem. PRELOADASYNC IS NOT A VALID TEST FOR
-- rbxasset:// CONTENT -- it is built for the asset service, and local client
-- content does not necessarily come back through it with IsLoaded set. So a
-- careful gate, written to fail safe, failed CLOSED on everything and turned
-- the whole feature off.
--
-- The rule that follows is worth keeping: DO NOT GATE A FEATURE ON A CHECK YOU
-- CANNOT RUN. A sound that is simply played either works or logs a warning from
-- the engine and costs nothing; a sound behind an unverifiable test is silent
-- for reasons nobody can see. So nothing here gates any more -- it assigns and
-- plays, and the only thing the checking does now is REPORT.

local SoundService = game:GetService("SoundService")

local Audio = {}

-- ---------------------------------------------------------------- the slots

-- Ordered candidates. Put a real asset id ("rbxassetid://...") at the front of
-- a list to override it -- that is the entire upgrade path for when the audio
-- in §6 is finally uploaded.
local SLOTS: { [string]: { string } } = {
	-- THE ENGINE IS ONE SUSTAINED SOUND, PITCHED. There is no engine loop in the
	-- client library and no oscillator in Luau, so the engine is whichever of
	-- these lands, with PlaybackSpeed following road speed and volume following
	-- the throttle. It reads as an engine because it rises and falls when you
	-- ask it to, which is the part the ear is actually listening to.
	engine = {
		"rbxasset://sounds/action_falling.mp3",
		"rbxasset://sounds/bass.wav",
		"rbxasset://sounds/action_swim.mp3",
		"rbxasset://sounds/uuhhh.mp3",
	},

	-- Something hard, for a building, a car or a person. Scaled by impact speed
	-- and pitched at the call site.
	impact = {
		"rbxasset://sounds/metal.ogg",
		"rbxasset://sounds/impact_water.mp3",
		"rbxasset://sounds/snap.mp3",
		"rbxasset://sounds/switch3.wav",
		"rbxasset://sounds/uuhhh.mp3",
	},

	-- The dispatch tones. Short, dry, and used sparingly -- a UI that pings at
	-- you constantly is a UI you turn off.
	ping = {
		"rbxasset://sounds/electronicpingshort.wav",
		"rbxasset://sounds/switch.wav",
		"rbxasset://sounds/clickfast.wav",
		"rbxasset://sounds/snap.mp3",
	},
	click = {
		"rbxasset://sounds/switch3.wav",
		"rbxasset://sounds/clickfast.wav",
		"rbxasset://sounds/switch.wav",
		"rbxasset://sounds/electronicpingshort.wav",
	},

	-- THE SIREN: one tone, pitched between two values on a timer, because a
	-- two-tone siren IS two pitches of one note.
	siren = {
		"rbxasset://sounds/bass.wav",
		"rbxasset://sounds/electronicpingshort.wav",
		"rbxasset://sounds/action_falling.mp3",
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

-- Which slot belongs to which mixer group. Anything not listed goes to effects.
local CATEGORY: { [string]: string } = {
	engine = "Engine",
	impact = "Effects",
	fire = "Effects",
	siren = "Effects",
	ping = "Interface",
	click = "Interface",
}

-- ---------------------------------------------------------------- the mixer

-- THREE GROUPS, AND "MASTER" IS ARITHMETIC.
--
-- The obvious build nests them: a Master SoundGroup with Engine, Effects and
-- Interface under it, so Roblox multiplies for you. The first attempt did that
-- by setting `group.SoundGroup = master`, which is not a thing:
--
--     SoundGroup is not a valid member of SoundGroup "Interface"
--
-- and because that is a module-scope error, it did not just lose the mixer. It
-- took Audio down, and Audio down took VehicleController, DispatchUI, Life and
-- SettingsUI with it -- every client script that requires it. What was left
-- running was the minimap and the city, so the game looked built and finished
-- loading and left the camera wherever the loading screen had parked it. The
-- report was "very long loading and i am in the sky".
--
-- THE SECOND MISTAKE OF THE SAME KIND IN THIS FILE, which is the reason for the
-- shape of the fix rather than a smaller one. Nesting may well work by parenting
-- instead -- but "may well" is exactly the confidence that produced the last
-- two rounds of this, so the master is a multiplier in Luau over three flat
-- groups and there is no API here that can be wrong.
--
-- AND THE WHOLE THING IS WRAPPED, so that even a mistake nobody has thought of
-- yet costs the mixer and not the car.
local groups: { [string]: SoundGroup } = {}
local base: { [string]: number } = { Engine = 1.0, Effects = 0.5, Interface = 0.6 }
local master = 1

local function applyGains()
	for name, g in groups do
		g.Volume = base[name] * master
	end
end

do
	local ok, err = pcall(function()
		for name, vol in base do
			local g = Instance.new("SoundGroup")
			g.Name = name
			g.Volume = vol
			g.Parent = SoundService
			groups[name] = g
		end
	end)
	if not ok then
		-- Everything downstream copes with an empty table: a Sound with no group
		-- plays at its own volume, which is the balance minus the master slider.
		warn("[audio] no mixer (" .. tostring(err) .. ") -- sounds play ungrouped")
		table.clear(groups)
	end
end

-- 0..1 in. "Master" scales the other three; the rest set their own level.
-- Unknown names are ignored rather than thrown, because this is driven by a UI
-- and a typo there must not stop the game.
function Audio.setVolume(group: string, v: number)
	v = math.clamp(v, 0, 1)
	if group == "Master" then
		master = v
		applyGains()
	elseif base[group] then
		base[group] = v
		applyGains()
	end
end

function Audio.getVolume(group: string): number
	if group == "Master" then
		return master
	end
	return base[group] or 0
end

Audio.GROUPS = { "Master", "Engine", "Effects", "Interface" }

-- Which candidate is KNOWN to work, once anything has established it. Empty is
-- not a failure state: it just means nothing has confirmed one yet, and the
-- first candidate is used meanwhile.
local chosen: { [string]: string } = {}

local function best(slot: string): string?
	local known = chosen[slot]
	if known then
		return known
	end
	local list = SLOTS[slot]
	if not list or #list == 0 then
		return nil
	end
	return list[1]
end

-- ---------------------------------------------------------------- playing

-- A Sound the caller owns. Parent it to a part and Roblox does the 3D placement
-- and rolloff; parent it to nothing and it is 2D.
--
-- NEVER NIL for a slot that exists, which is the difference from the version
-- that gated on a probe: there is no "not resolved yet" state to cope with any
-- more, so callers do not need retry logic and cannot end up permanently silent
-- because they asked one frame too early.
function Audio.make(slot: string, parent: Instance?): Sound?
	local id = best(slot)
	if not id then
		warn("[audio] no such slot: " .. slot)
		return nil
	end
	local s = Instance.new("Sound")
	s.SoundId = id
	s.SoundGroup = groups[CATEGORY[slot] or "Effects"]
	s.Parent = parent or SoundService
	return s
end

-- Fire and forget: a one-shot at a position, cleaned up when it finishes.
function Audio.shot(slot: string, at: Vector3?, volume: number?, speed: number?)
	local id = best(slot)
	if not id then
		return
	end
	local s = Instance.new("Sound")
	s.SoundId = id
	s.SoundGroup = groups[CATEGORY[slot] or "Effects"]
	s.Volume = volume or 0.5
	s.PlaybackSpeed = speed or 1

	if at then
		-- A Sound is only positional if its parent has a position, so a one-shot
		-- in the world gets a speck of a Part to hang off.
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

-- ---------------------------------------------------------------- the report

-- WHAT ACTUALLY EXISTS ON THIS CLIENT, established by PLAYING each candidate
-- rather than by asking a loader about it -- which is the one method that could
-- not be wrong about local content, because it is what the game does anyway.
--
-- Silent (Volume 0) and stopped immediately, so this is inaudible. It reports
-- once, and it sets `chosen` for every slot it can, so the sounds that follow
-- go straight to a path known to work rather than to a guess.
--
-- It never gates anything. If it finds nothing, every slot still plays its
-- first candidate and Roblox logs its own complaint -- which is strictly more
-- information than a silence this file decided on.
function Audio.warm()
	task.spawn(function()
		local probe = Instance.new("Sound")
		probe.Volume = 0
		-- NO SOUNDGROUP on the probe. Volume 0 is already silent, but a group is
		-- a multiplier and somebody will eventually wonder why turning Master up
		-- makes the loading screen click.
		probe.Parent = SoundService

		local lines: { string } = {}
		local anyWorked = false

		for slot, list in SLOTS do
			local found: string? = nil
			for _, id in list do
				probe.SoundId = id
				-- PCALLED because assigning a malformed content string throws,
				-- and a hand-written rbxasset path is exactly that risk.
				pcall(function()
					probe:Play()
				end)
				-- A moment for the engine to either load it or not. Local
				-- content is effectively instant; this is generous.
				local t0 = os.clock()
				while os.clock() - t0 < 0.6 do
					if probe.IsLoaded or probe.TimeLength > 0 then
						break
					end
					task.wait(0.05)
				end
				local ok = probe.IsLoaded or probe.TimeLength > 0
				probe:Stop()
				if ok then
					found = id
					break
				end
			end
			if found then
				chosen[slot] = found
				anyWorked = true
				table.insert(lines, ("  %-7s %s"):format(slot, found))
			else
				table.insert(lines, ("  %-7s NONE of %d candidates loaded"):format(slot, #list))
			end
		end

		probe:Destroy()

		print("[audio] what loaded on this client:\n" .. table.concat(lines, "\n"))
		if not anyWorked then
			warn(
				"[audio] nothing in the client's own sound library loaded. Every slot will "
					.. "still try its first candidate, so the engine's own warnings in this "
					.. "log will name the paths that do not exist. Fix by putting a working "
					.. "rbxassetid:// at the front of that slot's list in Shared/Audio."
			)
		end
	end)
end

return Audio
