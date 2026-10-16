import { sqlite } from "./db.js";
import { googleDataSwitchedOn, setGoogleDataEnabled } from "./google/dataLink.js";
import { setLocalCapability, setWithdrawnReserved, storedCapabilityOn, withdrawnReserved } from "./localCapabilities.js";
import { RESERVED_FEATURES, reservedFeatureOffered, reservedWordFrom, setReservedFeatures, type ReservedFeature } from "./reservedFeatures.js";

// The Desktop's word on what is offered to the person (reservedFeatures.ts),
// applied. While it is not final (what the Desktop last knew, the account
// not asked yet or not reachable) it only hides: the person's switches are
// kept as they were. Once final — the account answered, or this computer has
// no account — what is no longer offered and was on is switched off, its
// data kept (the mailbox's settings and copy, the Google link), and noted
// for the app to say once (`withdrawn` in GET /local_capabilities).
export function applyReservedWord(data: unknown): ReservedFeature[] {
  const word = reservedWordFrom(data);
  setReservedFeatures(word);
  if (!word.final) return [];
  const switchedOff: ReservedFeature[] = [];
  const users = sqlite.prepare("SELECT id FROM users").all() as Array<{ id: string }>;
  for (const { id: userId } of users) {
    const withdrawn = new Set<ReservedFeature>(withdrawnReserved(userId));
    for (const feature of RESERVED_FEATURES) {
      if (reservedFeatureOffered(feature)) continue;
      if (feature === "email" && storedCapabilityOn(userId, "email")) {
        setLocalCapability(userId, "email", false);
        withdrawn.add(feature);
        switchedOff.push(feature);
      }
      if (feature === "google_data" && googleDataSwitchedOn(userId)) {
        setGoogleDataEnabled(userId, false);
        withdrawn.add(feature);
        switchedOff.push(feature);
      }
    }
    setWithdrawnReserved(userId, [...withdrawn]);
  }
  return switchedOff;
}
