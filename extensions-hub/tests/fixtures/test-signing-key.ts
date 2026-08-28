// TEST FIXTURE ONLY. This RFC 8032 key is public test-vector material and must
// never be configured in a deployed Vast Extensions Hub environment.
const testSeed = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'
const testPublic = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'

export const TEST_SIGNING_KEY_ID = 'vast-hub-test-only'
export const TEST_SIGNING_PRIVATE_PKCS8 = Buffer.from(`302e020100300506032b657004220420${testSeed}`, 'hex').toString('base64')
export const TEST_SIGNING_PUBLIC_SPKI = Buffer.from(`302a300506032b6570032100${testPublic}`, 'hex').toString('base64')
