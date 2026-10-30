type ReleaseClient = {
  get(key: string): Promise<string | null>;
  eval(script: string, count: number, ...args: string[]): Promise<unknown>;
};

const RELEASE = `
local actual=redis.call('GET',KEYS[1])
if not actual then return 0 end
if actual~=ARGV[1] then return redis.error_reply('hold changed') end
local hold=cjson.decode(actual)
for i=2,3 do
  local t=redis.call('TYPE',KEYS[i]).ok
  if t~='none' and t~='string' then return redis.error_reply('invalid hold pointer') end
end
for i=4,5 do
  local t=redis.call('TYPE',KEYS[i]).ok
  if t~='none' and t~='set' then return redis.error_reply('invalid hold index') end
end
local slotRaw=redis.call('GET',KEYS[6])
local slot=nil
if slotRaw then
  local ok,value=pcall(cjson.decode,slotRaw)
  if not ok or type(value)~='table' or type(value.capacity)~='number' or type(value.remaining)~='number'
    or value.capacity<0 or value.capacity%1~=0 or value.remaining<0 or value.remaining%1~=0
    or value.remaining>value.capacity or value.capacity>9007199254740991 then
    return redis.error_reply('invalid legacy slot')
  end
  slot=value
  slot.remaining=slot.remaining+math.min(hold.pax,slot.capacity-slot.remaining)
end
local lock=redis.call('GET',KEYS[2])
local mapping=redis.call('GET',KEYS[3])
local slotJson=slot and cjson.encode(slot) or nil
redis.call('DEL',KEYS[1])
redis.call('SREM',KEYS[4],hold.holdId)
if ARGV[2]=='1' then redis.call('SREM',KEYS[5],hold.holdId) end
if lock==hold.holdId then redis.call('DEL',KEYS[2]) end
if ARGV[3]=='1' and mapping==hold.holdId then redis.call('DEL',KEYS[3]) end
if slotJson then redis.call('SET',KEYS[6],slotJson) end
return 1
`;

/** Compare-and-release only this hold. Never delete a newer lock/mapping;
 * never retry an uncertain EVAL response. Call within the paid journal when
 * releasing capacity on payment, AFTER confirmed capacity has been written. */
export async function releaseRedisBookingHold(
  client: ReleaseClient,
  holdId: string,
): Promise<void> {
  try {
    if (typeof holdId !== "string" || !holdId || holdId.length > 200) {
      throw new Error();
    }
    const key = `hold:${holdId}`;
    const raw = await client.get(key);
    if (raw === null) {
      return;
    }
    const hold = JSON.parse(raw);
    if (
      !hold ||
      hold.holdId !== holdId ||
      typeof hold.slotKey !== "string" ||
      !hold.slotKey ||
      !Number.isSafeInteger(hold.pax) ||
      hold.pax < 1 ||
      (hold.poolDayKey !== undefined &&
        (typeof hold.poolDayKey !== "string" || !hold.poolDayKey)) ||
      (hold.idempotencyKey !== undefined &&
        (typeof hold.idempotencyKey !== "string" || !hold.idempotencyKey))
    ) {
      throw new Error();
    }
    // Unused placeholders alias keys with the same expected type, so no new
    // Redis namespace or dummy key is created for optional fields.
    const lock = `lock:slot:${hold.slotKey}`;
    const slotIndex = `hold:slot:${hold.slotKey}`;
    const keys = [
      key,
      lock,
      hold.idempotencyKey ? `idempo:${hold.idempotencyKey}` : lock,
      slotIndex,
      hold.poolDayKey ? `hold:pool:${hold.poolDayKey}` : slotIndex,
      `slot:${hold.slotKey}`,
    ];
    const result = await client.eval(
      RELEASE,
      keys.length,
      ...keys,
      raw,
      hold.poolDayKey ? "1" : "0",
      hold.idempotencyKey ? "1" : "0",
    );
    if (result !== 0 && result !== 1) {
      throw new Error();
    }
  } catch {
    throw new Error("Booking hold release requires reconciliation");
  }
}
