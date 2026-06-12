const express = require('express');
const { parse } = require('csv-parse/sync');

module.exports = function(db, upload){
  const router = express.Router();

  router.post('/import', upload.single('file'), async (req,res)=>{
    if(!req.file) return res.status(400).json({ error: 'Archivo requerido' });
    const csv = req.file.buffer.toString('utf8');
    const records = parse(csv,{columns:true,delimiter:';',skip_empty_lines:true,trim:true});
    const values = [];

    for(const r of records){
      if(!r.USERID || !r.Badgenumber || !r.Name) continue;
      values.push([Number(r.USERID), r.Badgenumber, r.Name]);
    }
    if(values.length>0){
      await db.query(`
        INSERT INTO Users (USERID,Badgenumber,Name)
        VALUES ?
        ON DUPLICATE KEY UPDATE Badgenumber=VALUES(Badgenumber), Name=VALUES(Name)
      `, [values]);
    }
    res.json({ ok:true, users: values.length });
  });

  router.get('/', async (req,res)=>{
    const [users] = await db.query(`SELECT USERID,Badgenumber,Name FROM Users ORDER BY Name`);
    res.json(users);
  });

  return router;
};