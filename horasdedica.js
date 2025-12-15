const express = require('express');
const fs = require('fs');
const mysql = require('mysql2'); // O sequelize si prefieres ORM

const app = express();
const port = process.env.PORT || 3000;

// Conexión a la base de datos de Clever Cloud
const connection = mysql.createConnection({
  host: process.env.MYSQL_ADDON_HOST,
  user: process.env.MYSQL_ADDON_USER,
  password: process.env.MYSQL_ADDON_PASSWORD,
  database: process.env.MYSQL_ADDON_DB,
  port: process.env.MYSQL_ADDON_PORT || 3306,
});

// Middleware para parsear JSON
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Ruta para importar CSV
app.post('/importar-csv', (req, res) => {
  const { fileName, tableName } = req.body;
  const filePath = `./path/to/csv/${fileName}`;

  const csvData = fs.readFileSync(filePath, 'utf8');
  const rows = csvData.split('\n').map(row => row.split(';'));

  rows.forEach(row => {
    // Suponiendo que cada fila tiene los datos que se deben insertar
    const [userId, checkIn, checkOut] = row;

    connection.query('INSERT INTO Fichajes (userId, checkIn, checkOut) VALUES (?, ?, ?)', [userId, checkIn, checkOut], (err) => {
      if (err) {
        console.error('Error insertando datos:', err);
        res.status(500).send('Error en la importación');
      }
    });
  });

  res.status(200).send('Datos importados correctamente');
});

// Iniciar el servidor
app.listen(port, () => {
  console.log(`Backend corriendo en http://localhost:${port}`);
});
