/**
 * Soft-delete plugin for Mongoose schemas.
 *
 * Adds a nullable `deletedAt` timestamp (null = live) and query middleware that
 * transparently hides soft-deleted documents from every ordinary read/update.
 * This fails safe: any query that forgets to filter still excludes deleted rows.
 *
 * Usage:
 *   const softDelete = require('./plugins/softDelete');
 *   mySchema.plugin(softDelete);
 *
 * Deleting:
 *   await Model.softDeleteById(id);            // returns the updated doc (or null)
 *   await Model.softDeleteOne({ _id, company });
 *   await doc.softDelete();
 *
 * Including deleted (rare — e.g. restore, admin views):
 *   Model.find(filter, null, { withDeleted: true })
 *   Model.findOne(filter).setOptions({ withDeleted: true })
 *
 * Note: aggregation pipelines bypass query middleware — add an explicit
 * `{ $match: { deletedAt: null } }` stage where accuracy matters.
 */
module.exports = function softDeletePlugin(schema) {
  schema.add({ deletedAt: { type: Date, default: null } });
  schema.index({ deletedAt: 1 });

  // Every read/update funnels through one of these; findById → findOne.
  const HOOKS = [
    'count',
    'countDocuments',
    'find',
    'findOne',
    'findOneAndUpdate',
    'findOneAndDelete',
    'findOneAndReplace',
    'updateOne',
    'updateMany',
    'distinct',
  ];

  HOOKS.forEach((hook) => {
    schema.pre(hook, function softDeleteFilter() {
      // Opt out explicitly with { withDeleted: true } in the query options.
      if (this.getOptions && this.getOptions().withDeleted) return;
      const query = this.getQuery ? this.getQuery() : {};
      // Respect an explicit deletedAt condition supplied by the caller.
      if (!('deletedAt' in query)) {
        this.where({ deletedAt: null });
      }
    });
  });

  schema.methods.softDelete = function softDelete() {
    this.deletedAt = new Date();
    return this.save();
  };

  // Soft-delete by filter/id. The findOneAndUpdate middleware above scopes these
  // to live docs, so a second delete is a no-op (returns null).
  schema.statics.softDeleteOne = function softDeleteOne(filter, options = {}) {
    return this.findOneAndUpdate(filter, { deletedAt: new Date() }, { new: true, ...options });
  };

  schema.statics.softDeleteById = function softDeleteById(id, options = {}) {
    return this.findOneAndUpdate({ _id: id }, { deletedAt: new Date() }, { new: true, ...options });
  };

  // Restore a soft-deleted document (opts past the read filter).
  schema.statics.restoreById = function restoreById(id) {
    return this.findOneAndUpdate(
      { _id: id },
      { deletedAt: null },
      { new: true, withDeleted: true }
    );
  };
};
