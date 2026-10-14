# Documentos legales de Horas Dedica

> **BORRADORES para revisar con un abogado.** No son asesoramiento legal.
> Redactados el 2026-10-14 a partir de la Ley 25.326, la Disposición
> 60-E/2016 y la Resolución AAIP 47/2018, y de cómo funciona el sistema hoy.

| Archivo | Para quién | Dónde se muestra |
|---|---|---|
| `TERMINOS_Y_CONDICIONES.md` | Empresas clientes | Landing + aceptación en el sistema |
| `ACUERDO_TRATAMIENTO_DATOS.md` | Empresas clientes (anexo de los Términos) | Aceptación en el sistema |
| `POLITICA_PRIVACIDAD.md` | Cualquier visitante y clientes | Landing (pie de página) y sistema |
| `AVISO_EMPLEADOS_MODELO.md` | Lo entrega el cliente a sus empleados | Se descarga desde el sistema; portal del empleado |
| `PROCEDIMIENTO_INCIDENTES.md` | Uso interno de Horas Dedica | No se publica |

## Antes de publicar: completar

Buscar `[COMPLETAR` en los archivos:

- Razón social / nombre del titular, CUIT, domicilio legal.
- Email de contacto para privacidad y soporte.
- Jurisdicción (tribunales de la ciudad del titular).
- Región donde corre el servidor en Render (verificar en el panel de Render).
- Si el titular de las bases quedó inscripto en la AAIP, el número.

## Cómo se aceptan (todo online, sin papel)

En Argentina un contrato entre empresas no necesita una forma especial
(Código Civil y Comercial, **art. 1015**, libertad de formas) y la aceptación
electrónica sirve como prueba (Ley 25.506 de firma digital/electrónica). Lo
habitual en SaaS es el **"clickwrap"**: la persona tilda "Leí y acepto" y se
guarda la prueba. Para que sirva:

1. **Que se pueda leer antes de aceptar** (link al texto completo, en la
   versión exacta que acepta).
2. **Un acto expreso**: casilla sin tildar de antemano + botón "Acepto".
3. **Quién acepta tiene que poder obligar a la empresa**: el titular o un
   administrador; se le pide declarar que tiene facultades.
4. **Guardar la prueba**: empresa, usuario, email, documento, **versión y
   huella (hash) del texto**, fecha y hora, IP y navegador. Esa fila no se
   modifica nunca.
5. **Copia al cliente**: mail con los textos aceptados (o PDF descargable).
6. **Cambios futuros**: se avisa con anticipación y se vuelve a pedir la
   aceptación de la nueva versión.

Si un cliente grande pide firma "fuerte", se puede firmar el Acuerdo de
Tratamiento con **firma digital** (ej. plataforma de firma con token o
certificado) o enviarlo por mail y guardar su respuesta de aceptación.

### Lo que hay que construir en el sistema para esto

- Tabla de aceptaciones (solo agregar, nunca editar ni borrar).
- Al aprobar una solicitud de alta y en el primer ingreso del titular:
  pantalla con los tres textos y la casilla "Leí y acepto en nombre de la
  empresa, y declaro tener facultades para hacerlo".
- Casilla de aceptación de la Política de Privacidad en el formulario de la
  landing.
- Pie de página de la landing y del sistema con links a los textos.
- Versión de cada documento: si cambia, pedir de nuevo la aceptación.
