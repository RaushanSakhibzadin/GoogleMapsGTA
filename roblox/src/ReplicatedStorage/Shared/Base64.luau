--!strict
-- Base64 to a buffer. Luau has no decoder of its own.
--
-- Two baked files arrive this way -- the drivable road mask and the minimap
-- picture -- for the same reason: a table of twenty thousand ones and zeros is
-- forty times the bytes and has to be parsed as Luau source on every join,
-- while a string is one allocation and a tight loop. The minimap alone is
-- 64 kB packed against 786 kB as RGB.

local Base64 = {}

local ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local LOOKUP: { [number]: number } = {}
for i = 1, #ALPHABET do
	LOOKUP[string.byte(ALPHABET, i)] = i - 1
end

function Base64.decode(s: string): buffer
	local clean = string.gsub(s, "=", "")
	local n = #clean
	local out = buffer.create((n * 6) // 8)
	local acc, bits, at = 0, 0, 0

	for i = 1, n do
		local v = LOOKUP[string.byte(clean, i)]
		if v == nil then
			continue -- a newline or stray whitespace
		end
		acc = acc * 64 + v
		bits += 6
		if bits >= 8 then
			bits -= 8
			buffer.writeu8(out, at, (acc // (2 ^ bits)) % 256)
			at += 1
			acc %= 2 ^ bits
		end
	end
	return out
end

return Base64
