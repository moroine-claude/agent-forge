// herdr-core (hc), pinned (DX 5 spec §5.6). The image's Ansible role pins the
// same version, `forge_image_hc_version` in
// ansible/roles/forge_image/defaults/main.yml: tests/hc.test.ts keeps the two
// equal. The Mac's check of its own hc goes here (part 1c).
export const HC_VERSION = "0.1.20";
