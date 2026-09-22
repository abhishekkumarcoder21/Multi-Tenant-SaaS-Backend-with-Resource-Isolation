-- Sliding Window Rate Limiter Lua Script
--
-- KEYS[1] = current window key:  rl:{tenant_id}:{current_window_timestamp}
-- KEYS[2] = previous window key: rl:{tenant_id}:{prev_window_timestamp}
--
-- ARGV[1] = limit (max requests allowed in window)
-- ARGV[2] = window size in seconds (e.g. 60)
-- ARGV[3] = current timestamp (seconds with fraction, e.g. 1727050000.123)
-- ARGV[4] = window start timestamp (seconds, e.g. 1727049960)
--
-- Returns table: { allowed (1 or 0), remaining_tokens, reset_after_seconds }

local current_key = KEYS[1]
local prev_key = KEYS[2]

local limit = tonumber(ARGV[1])
local window_size = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local current_window_start = tonumber(ARGV[4])

-- Get counts for current and previous window
local current_count = tonumber(redis.call('get', current_key) or '0')
local prev_count = tonumber(redis.call('get', prev_key) or '0')

-- Calculate position within current window: fraction from 0.0 to 1.0
local time_into_current = now - current_window_start
local weight = (window_size - time_into_current) / window_size
if weight < 0 then
  weight = 0
elseif weight > 1 then
  weight = 1
end

-- Estimated requests in sliding window = previous_window * weight + current_window
local estimated_count = math.floor(prev_count * weight + current_count)

if estimated_count < limit then
  -- Allowed: increment current window counter and set TTL (2x window size for safety)
  redis.call('incr', current_key)
  redis.call('expire', current_key, window_size * 2)

  local remaining = limit - (estimated_count + 1)
  if remaining < 0 then
    remaining = 0
  end

  local reset_after = math.ceil(window_size - time_into_current)
  return { 1, remaining, reset_after }
else
  -- Rejected: rate limit exceeded
  local reset_after = math.ceil(window_size - time_into_current)
  return { 0, 0, reset_after }
end
