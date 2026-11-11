const {createHash}=require('node:crypto');

const PROFILE='team_summary_v1';
const HASH=/^[0-9a-f]{64}$/;
const brandedProofs=new WeakSet();
const metadataByProof=new WeakMap();

function assertExactObject(value,keys,label) {
  if(!value||typeof value!=='object'||Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const actual=Reflect.ownKeys(value);
  if(actual.length!==keys.length||actual.some(key=>typeof key!=='string'||!keys.includes(key))) {
    throw new TypeError(`${label} has invalid fields`);
  }
}

function assertContent(content) {
  if(typeof content!=='string') throw new TypeError('content must be a string');
}

function assertHash(value,label) {
  if(typeof value!=='string'||!HASH.test(value)) throw new TypeError(`${label} must be a SHA-256 hash`);
}

function contentHash(content) {
  return createHash('sha256').update(content,'utf8').digest('hex');
}

// Trusted-caller primitive only. The caller MUST rebuild source records and
// authenticate their exact deterministic render before creating this proof.
// Branding proves in-process provenance, not source authenticity.
function createFactContextProjection(content,options) {
  assertContent(content);
  assertExactObject(options,['catalogHash','sourceRecordsHash','profile'],'projection options');
  const {catalogHash,sourceRecordsHash,profile}=options;
  assertHash(catalogHash,'catalogHash');
  assertHash(sourceRecordsHash,'sourceRecordsHash');
  if(profile!==PROFILE) throw new TypeError('unsupported projection profile');

  const metadata=Object.freeze({
    profile,
    catalogHash,
    sourceRecordsHash,
    contentHash:contentHash(content),
  });
  const proof=Object.freeze({});
  brandedProofs.add(proof);
  metadataByProof.set(proof,metadata);
  return proof;
}

function readFactContextProjection(proof,options) {
  assertExactObject(options,['content','catalogHash'],'projection read options');
  const {content,catalogHash}=options;
  assertContent(content);
  assertHash(catalogHash,'catalogHash');
  if(!proof||typeof proof!=='object'||!brandedProofs.has(proof)) throw new TypeError('unbranded fact context projection');
  const metadata=metadataByProof.get(proof);
  if(!metadata||metadata.catalogHash!==catalogHash||metadata.contentHash!==contentHash(content)) {
    throw new TypeError('fact context projection mismatch');
  }
  return metadata;
}

module.exports={createFactContextProjection,readFactContextProjection};
