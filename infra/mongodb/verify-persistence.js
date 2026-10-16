// Run only against an operator-approved test database. No credentials are printed.
const admin = db.getSiblingDB('admin');
if (!admin.auth(process.env.MONGO_INITDB_ROOT_USERNAME, process.env.MONGO_INITDB_ROOT_PASSWORD)) {
  throw new Error('Authentication failed');
}
const hello = admin.runCommand({hello: 1});
if (hello.setName !== 'urumi' || !hello.isWritablePrimary) {
  throw new Error('Expected writable urumi replica set');
}
const database = db.getSiblingDB('urumi_deployment_verification');
const phase = process.env.URUMI_VERIFY_PHASE;
if (!['seed', 'restore'].includes(phase)) throw new Error('Choose seed or restore');
if (phase === 'restore' && database.markers.findOne({_id: 'persistence'})?.value !== 'retained') {
  throw new Error('Persistent marker missing after restart');
}
// Create the collection before starting the transaction; reruns preserve existing data.
if (!database.getCollectionNames().includes('markers')) database.createCollection('markers');
const session = db.getMongo().startSession();
try {
  session.startTransaction({writeConcern: {w: 'majority'}});
  const markers = session.getDatabase(database.getName()).markers;
  markers.updateOne({_id: 'persistence'}, {$set: {value: 'retained'}}, {upsert: true});
  markers.updateOne({_id: phase}, {$set: {transaction: 'committed'}}, {upsert: true});
  session.commitTransaction();
} finally {
  session.endSession();
}
if (database.markers.findOne({_id: phase})?.transaction !== 'committed') {
  throw new Error('Transaction verification failed');
}
print(`MongoDB ${phase}: persistent marker and majority transaction verified`);
