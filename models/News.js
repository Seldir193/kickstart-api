// models/News.js
'use strict';
const mongoose = require('mongoose');

const MediaSchema = new mongoose.Schema({
  type: { type: String, enum: ['image','video'], required: true },
  url:  { type: String, required: true },
  alt:  { type: String, default: '' },
  title:{ type: String, default: '' },
}, { _id:false });

const NewsSchema = new mongoose.Schema({
  providerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Provider', index:true },
  date:       { type: Date, required: true, index:true },
  title:      { type: String, required: true, trim:true },


  slug:       { type: String, required: true, unique:true, lowercase:true, trim:true },

  // NEU
  category: { 
    type: String,
    enum: ['Allgemein','News','Partnerverein','Projekte'],
    default: 'News',
    index: true
  },
  tags: { type: [String], default: [], index: true },

  excerpt:    { type: String, default: '' },
  content:    { type: String, default: '' },
  coverImage: { type: String, default: '' },
  media:      { type: [MediaSchema], default: [] },
  published:  { type: Boolean, default: true },
}, { timestamps:true });

//NewsSchema.index({ date: -1 });

NewsSchema.index({ title: 'text', excerpt: 'text', content: 'text' });

module.exports = mongoose.model('News', NewsSchema);











