import { randomBytes, randomUUID } from "node:crypto";
import { signApprovalV2, signBinding, signDesktopBinding, signDeviceAccess } from "../../src/vault/contracts.js";
import { createDeviceKeys, signApproval, toHex, type DeviceKeys } from "../../src/vault/crypto.js";
import type { Anchor, VaultDevice } from "../../src/vault/client.js";

// A vault as GET /vault returns it, signed like the real one (approval/v2,
// computer-binding-v1, desktop-binding-v1), for the mesh roster's tests
// (lot S2): the iPhone founds it and is this computer's anchor; it approves
// and binds the account's computers; a Twoody Desktop is a person device
// that binds itself; each computer has a tunnel key of its own.

export type MeshDevice = VaultDevice & { keys: DeviceKeys };

export function meshVault(userId: string | number = "42") {
  const devices: MeshDevice[] = [];
  const user = String(userId);

  function add(label: string, extra: Partial<VaultDevice> = {}): MeshDevice {
    const keys = createDeviceKeys();
    const device: MeshDevice = {
      id: randomUUID(), label, enc_public: toHex(keys.encPublic), sign_public: toHex(keys.signPublic), status: "trusted",
      approval: null, kind: "person", account_computer_id: null, binding: null, keys, ...extra,
    };
    devices.push(device);
    return device;
  }

  /// A person device approved by `approver` (v2 person); the founding one approves itself.
  function person(label: string, approver?: MeshDevice, options: { v1?: boolean } = {}): MeshDevice {
    const device = add(label);
    const by = approver ?? device;
    device.approval = {
      approver_id: by.id,
      signature: options.v1
        ? signApproval({ userId: user, device, approverId: by.id, signPrivate: by.keys.signPrivate })
        : signApprovalV2({ userId: user, device, approverId: by.id, kind: "person", signPrivate: by.keys.signPrivate }),
    };
    return device;
  }

  /// A computer approved (v2 computer) and bound by `approver`.
  function computer(label: string, accountComputerId: string, approver: MeshDevice, options: { canApprove?: boolean; tunnelKey?: string; pairingKey?: string; v1?: boolean; bindingSigner?: MeshDevice } = {}) {
    const device = add(label, { kind: "computer", account_computer_id: accountComputerId });
    const tunnelKey = options.tunnelKey ?? randomBytes(32).toString("hex");
    device.approval = {
      approver_id: approver.id,
      signature: options.v1
        ? signApproval({ userId: user, device, approverId: approver.id, signPrivate: approver.keys.signPrivate })
        : signApprovalV2({ userId: user, device, approverId: approver.id, kind: "computer", accountComputerId, signPrivate: approver.keys.signPrivate }),
    };
    const signer = options.bindingSigner ?? approver;
    const binding = {
      vault_device_id: device.id, account_computer_id: accountComputerId, tunnel_public_key: tunnelKey,
      pairing_public_key: options.pairingKey ?? randomBytes(32).toString("hex"), can_approve: options.canApprove ?? false,
    };
    device.binding = JSON.stringify({ ...binding, approver_id: signer.id, signature: signBinding({ userId: user, binding, signPrivate: signer.keys.signPrivate }) });
    return Object.assign(device, { tunnelKey });
  }

  /// A Twoody Desktop: a person device approved by `approver` (v2 person)
  /// that names its account computer itself (desktop-binding-v1, signed by
  /// its own key, or by `signer` to forge one).
  function desktop(label: string, accountComputerId: string, approver: MeshDevice, options: { tunnelKey?: string; pairingKey?: string; signer?: MeshDevice } = {}) {
    const device = person(label, approver);
    const tunnelKey = options.tunnelKey ?? randomBytes(32).toString("hex");
    const binding = { vault_device_id: device.id, account_computer_id: accountComputerId, tunnel_public_key: tunnelKey, pairing_public_key: options.pairingKey ?? randomBytes(32).toString("hex") };
    device.desktop_binding = JSON.stringify({ ...binding, signature: signDesktopBinding({ userId: user, binding, signPrivate: (options.signer ?? device).keys.signPrivate }) });
    return Object.assign(device, { tunnelKey });
  }

  /// A phone's device-access-v1 for `tunnelKey`, signed by `signer`.
  function deviceAccess(signer: MeshDevice, tunnelKey: string) {
    const access = { vault_device_id: signer.id, tunnel_public_key: tunnelKey };
    return { ...access, signature: signDeviceAccess({ userId: user, access, signPrivate: signer.keys.signPrivate }) };
  }

  const anchorOf = (device: MeshDevice): Anchor => ({ id: device.id, sign_public: device.sign_public });

  return {
    devices,
    person,
    computer,
    desktop,
    deviceAccess,
    anchorOf,
    /// What the roster reads: the devices as the account lists them (no keys).
    input(anchors: MeshDevice[]) {
      return { userId: user, devices: devices.map(({ keys: _keys, ...d }) => ({ ...d })), anchors: anchors.map(anchorOf) };
    },
  };
}
