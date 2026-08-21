/**
 * Append-only plugin.
 *
 * Blocks every mutation and deletion path at the Mongoose layer, so a collection
 * can only ever grow. Used by the legal financial ledger and the legal document
 * access log, where the value of the record *is* that nobody could have changed
 * it after the fact.
 *
 * This is a correctness guard against our own future code, not a security
 * boundary — anyone with direct database access can still write. Pair it with
 * the hash chain (see plugins/hashChain.js) where tamper-evidence matters.
 *
 * Corrections are made by appending a reversing entry, never by editing.
 *
 * Usage:
 *   mySchema.plugin(appendOnly);
 *
 * Escape hatch for genuine system maintenance (migrations, retention purges):
 *   Model.updateOne(filter, update).setOptions({ allowMutation: true })
 */

const BLOCKED_UPDATES = [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'replaceOne',
];

const BLOCKED_DELETES = [
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
  'findOneAndRemove',
];

module.exports = function appendOnlyPlugin(schema) {
  const reject = (verb) => function guard(next) {
    if (this.getOptions && this.getOptions().allowMutation) return next();
    const name = this.model?.modelName || 'document';
    return next(
      new Error(
        `${name} is append-only: ${verb} is not permitted. ` +
        'Post a reversing entry instead of modifying history.'
      )
    );
  };

  for (const hook of BLOCKED_UPDATES) schema.pre(hook, reject(hook));
  for (const hook of BLOCKED_DELETES) schema.pre(hook, reject(hook));

  // Document-level: block re-saving anything that already exists, and block
  // instance .deleteOne()/.remove().
  schema.pre('save', function guardSave(next) {
    if (this.isNew || this.$locals?.allowMutation) return next();
    return next(
      new Error(
        `${this.constructor.modelName} is append-only: an existing entry cannot be re-saved.`
      )
    );
  });

  schema.pre('deleteOne', { document: true, query: false }, function guardDocDelete(next) {
    if (this.$locals?.allowMutation) return next();
    return next(new Error(`${this.constructor.modelName} is append-only: entries cannot be deleted.`));
  });

  // Bulk writes bypass the hooks above, so close that door too.
  schema.pre('bulkWrite', function guardBulk(next) {
    return next(new Error(`${this.modelName} is append-only: bulkWrite is not permitted.`));
  });
};
