// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/mac-address-lookup/oui-data.ts. See THIRD_PARTY.md.
/**
 * A curated subset of well-known IEEE OUI (Organizationally Unique Identifier)
 * assignments, keyed by the first three octets (6 uppercase hex chars).
 *
 * This is intentionally NOT the full ~35k-entry IEEE registry — bundling that
 * would bloat the client. It covers common hardware, virtualization and IoT
 * vendors so the tool is useful offline while staying small. Unknown prefixes
 * simply report "not found".
 */
export const OUI: Record<string, string> = {
  // Apple
  '000393': 'Apple, Inc.',
  '000A27': 'Apple, Inc.',
  '000A95': 'Apple, Inc.',
  '001B63': 'Apple, Inc.',
  '001EC2': 'Apple, Inc.',
  '002500': 'Apple, Inc.',
  '3C0754': 'Apple, Inc.',
  A45E60: 'Apple, Inc.',
  F01898: 'Apple, Inc.',
  ACBC32: 'Apple, Inc.',
  DCA904: 'Apple, Inc.',
  // Cisco
  '00000C': 'Cisco Systems, Inc',
  '001AA1': 'Cisco Systems, Inc',
  '001BD4': 'Cisco Systems, Inc',
  '002545': 'Cisco Systems, Inc',
  '002304': 'Cisco Systems, Inc',
  '68BDAB': 'Cisco Systems, Inc',
  '203706': 'Cisco Systems, Inc',
  // Cisco Meraki
  '00180A': 'Cisco Meraki',
  '881544': 'Cisco Meraki',
  E0553D: 'Cisco Meraki',
  // Intel
  '001B21': 'Intel Corporate',
  '001E67': 'Intel Corporate',
  '00AA00': 'Intel Corporation',
  '3C970E': 'Intel Corporate',
  A088B4: 'Intel Corporate',
  // Dell
  '001422': 'Dell Inc.',
  '001AA0': 'Dell Inc.',
  B82A72: 'Dell Inc.',
  '180373': 'Dell Inc.',
  F8BC12: 'Dell Inc.',
  // Samsung
  '0000F0': 'Samsung Electronics',
  '001247': 'Samsung Electronics',
  '342387': 'Samsung Electronics',
  '5C0A5B': 'Samsung Electronics',
  '8C7712': 'Samsung Electronics',
  E8508B: 'Samsung Electronics',
  // HP / Hewlett Packard
  '001B78': 'Hewlett Packard',
  '000F20': 'Hewlett Packard',
  '3CD92B': 'Hewlett Packard',
  '705A0F': 'Hewlett Packard',
  '0025B3': 'Hewlett Packard',
  // Huawei
  '00E0FC': 'Huawei Technologies',
  '00259E': 'Huawei Technologies',
  '4846FB': 'Huawei Technologies',
  '5C7D5E': 'Huawei Technologies',
  // Microsoft
  '00155D': 'Microsoft (Hyper-V)',
  '00125A': 'Microsoft Corporation',
  '0003FF': 'Microsoft Corporation',
  '281878': 'Microsoft Corporation',
  // Google
  '3C5AB4': 'Google, Inc.',
  '94EB2C': 'Google, Inc.',
  F4F5E8: 'Google, Inc.',
  // Amazon
  '44650D': 'Amazon Technologies',
  F0272D: 'Amazon Technologies',
  '74C246': 'Amazon Technologies',
  // TP-Link
  '14CC20': 'TP-Link Technologies',
  '50C7BF': 'TP-Link Technologies',
  EC086B: 'TP-Link Technologies',
  '6032B1': 'TP-Link Technologies',
  // Netgear
  '00095B': 'Netgear',
  '001B2F': 'Netgear',
  '20E52A': 'Netgear',
  A040A0: 'Netgear',
  // Xiaomi
  '286C07': 'Xiaomi Communications',
  '34CE00': 'Xiaomi Communications',
  '640980': 'Xiaomi Communications',
  '7811DC': 'Xiaomi Communications',
  F8A45F: 'Xiaomi Communications',
  // VMware
  '000569': 'VMware, Inc.',
  '000C29': 'VMware, Inc.',
  '005056': 'VMware, Inc.',
  '001C14': 'VMware, Inc.',
  // Raspberry Pi
  B827EB: 'Raspberry Pi Foundation',
  DCA632: 'Raspberry Pi Trading',
  E45F01: 'Raspberry Pi Trading',
  '28CDC1': 'Raspberry Pi Trading',
  // Ubiquiti
  '00156D': 'Ubiquiti Networks',
  '0418D6': 'Ubiquiti Networks',
  '24A43C': 'Ubiquiti Networks',
  '788A20': 'Ubiquiti Networks',
  FCECDA: 'Ubiquiti Networks',
  // Sony
  '0013A9': 'Sony Corporation',
  '001DBA': 'Sony Corporation',
  '30F9ED': 'Sony Corporation',
  FC0FE6: 'Sony Corporation',
  // LG
  '001C62': 'LG Electronics',
  '001E75': 'LG Electronics',
  '10F96F': 'LG Electronics',
  C4366C: 'LG Electronics',
  // ASUSTek
  '001BFC': 'ASUSTek Computer',
  '001FC6': 'ASUSTek Computer',
  '08606E': 'ASUSTek Computer',
  '2C56DC': 'ASUSTek Computer',
  AC220B: 'ASUSTek Computer',
  // D-Link
  '00055D': 'D-Link Corporation',
  '001B11': 'D-Link Corporation',
  '1CAFF7': 'D-Link Corporation',
  '78542E': 'D-Link Corporation',
  // Juniper
  '000585': 'Juniper Networks',
  '00121E': 'Juniper Networks',
  '3C8AB0': 'Juniper Networks',
  // Arista / Aruba / Fortinet
  '001C73': 'Arista Networks',
  '000B86': 'Aruba Networks',
  '24DEC6': 'Aruba Networks',
  '00090F': 'Fortinet, Inc.',
  '906CAC': 'Fortinet, Inc.',
  // Espressif (ESP8266 / ESP32)
  '240AC4': 'Espressif Inc.',
  '30AEA4': 'Espressif Inc.',
  '3C71BF': 'Espressif Inc.',
  '84F3EB': 'Espressif Inc.',
  A020A6: 'Espressif Inc.',
  '5CCF7F': 'Espressif Inc.',
  // Virtualization defaults
  '525400': 'QEMU / KVM (virtual)',
  '080027': 'VirtualBox (virtual)',
  '0242AC': 'Docker (locally administered)',
  // Nintendo / Roku
  '0009BF': 'Nintendo Co., Ltd.',
  '40F407': 'Nintendo Co., Ltd.',
  '98B6E9': 'Nintendo Co., Ltd.',
  B0A737: 'Roku, Inc.',
  CC6DA0: 'Roku, Inc.',
  // Realtek / Broadcom / Nokia
  '00E04C': 'Realtek Semiconductor',
  '001018': 'Broadcom',
  '000EED': 'Nokia',
  '547975': 'Nokia',
};

/** Number of prefixes in the bundled dataset (for the UI note). */
export const OUI_COUNT = Object.keys(OUI).length;
