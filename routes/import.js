const express = require('express');
const { parse } = require('csv-parse/sync');

module.exports = function(db, upload) {
  const router = express.Router();

  // IMPORT CHECKINS
  router.post('/checkins', upload.single('file'), async (req,res)=>{
    if (!req.file) return res.status(400).json({ error: 'Archivo requerido' });

    const csv = req.file.buffer.toString('utf8');
    const records = parse(csv, { columns:true, delimiter:';', skip_empty_lines:true, trim:true });

    let inserted=0, skipped=0, errors=0, batch=[];

    for(const r of records){
      const userIdClean = r.USERID?.toString().trim();
      const checktimeRaw = r.CHECKTIME?.toString().trim();
      const machine_ip = r.MACHINE_IP?.toString().trim() || null;
      const machine_sn = r.MACHINE_SN?.toString().trim() || null;
      if(!userIdClean || !checktimeRaw){ skipped++; continue; }

      const checktime = checktimeRaw;
      // Insertamos badge (USERID desde reloj), timestamp y metadata del reloj
      batch.push([Number(userIdClean), checktime, machine_ip, machine_sn]);
      if(batch.length>=50){
        try { await db.query(`INSERT IGNORE INTO Checkins (USERID,CHECKTIME,MACHINE_IP,MACHINE_SN) VALUES ?`, [batch]); inserted+=batch.length; batch=[]; }
        catch(err){ errors+=batch.length; batch=[]; }
      }
    }
    if(batch.length>0) try{ await db.query(`INSERT IGNORE INTO Checkins (USERID,CHECKTIME,MACHINE_IP,MACHINE_SN) VALUES ?`, [batch]); inserted+=batch.length; } catch(err){ errors+=batch.length; }

    res.json({ ok:true, inserted, skipped, errors, total:records.length });
  });

  return router;
};