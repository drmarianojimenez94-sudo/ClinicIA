# Simulación, navegación y circuito de pagos

## Publicado en esta iteración
- Tres simulaciones originales de Examen Único, nueve decisiones con cinco opciones: interpretación de pruebas, diseños epidemiológicos y delirium hipoactivo. Cada simulación registra intentos durante la sesión, permite corregir errores y termina con devolución y acceso a teoría.
- Tres temas ampliados con nueve secciones de teoría, fórmulas y criterios de interpretación. Las fuentes se conservan en cada lección; sigue pendiente validación docente.
- Tutor contextual dentro del caso después de responder, sin revelar por adelantado los pasos siguientes en la corrección editorial.
- Plan de cinco preguntas, priorizando errores y repasos; menú principal con seis entradas y herramientas secundarias desplegables.
- Reportes de preguntas autenticados, con motivo predefinido, control de duplicados y panel de administración. Sin texto clínico libre.

## Pagos: preparado, no activado
Nueva pantalla `/pagos.html`, órdenes persistentes, creación de preferencia Checkout Pro y comprobación del pago desde el servidor. Mantiene abierto el piloto. No implementa renovación automática ni bloquea contenido. La vigencia de treinta días se registra en la orden; no se presenta como un permiso que ya limite los cursos.

La configuración requiere exclusivamente en el servidor:
- MERCADOPAGO_ACCESS_TOKEN: credencial del vendedor de ClinicIA.
- CLINICIA_PRICE_ARS: precio decimal en pesos argentinos.
- CLINICIA_PRODUCT_TITLE y CLINICIA_PRODUCT_DESCRIPTION: producto y alcance comercial explícitos.
- CLINICIA_SELLER_NAME y CLINICIA_SUPPORT_EMAIL: responsable y canal de soporte.
- CLINICIA_PAYMENTS_ENABLED=true: activación deliberada, separada de configurar credenciales.

No se configuraron estos valores ni se copió una credencial de otro proyecto. Sin configuración completa el checkout devuelve 503 y la interfaz informa que se puede estudiar gratis. Antes de activarlo: completar oferta y condiciones, probar con credenciales de prueba del vendedor y resolver facturación y tratamiento de registros de compra. No se hicieron pagos reales.

Verificación: sólo se acepta un pago consultado a la API con external_reference, vendedor, moneda e importe coincidentes. Los parámetros de retorno del navegador no prueban pago. La misma requestKey reutiliza la orden y la verificación repetida no extiende vigencia. Un reintegro verificado retira la vigencia registrada.

Limitaciones explícitas: la conciliación es iniciada por el usuario desde «Verificar estado», no hay webhook ni proceso automático; no hay integración de facturación, gestión automática de devoluciones ni control de acceso premium. El piloto permanece abierto. No anunciar estos componentes como terminados para venta masiva.

## Validación
35 pruebas automáticas: cuentas, reportes, aislamiento de órdenes, importe manipulado, vendedor incorrecto, idempotencia, reintegros simulados, planes, simulaciones, fuentes y ausencia de respuestas antes de contestar. Integración de proveedor validada con dobles de prueba; falta prueba con una cuenta de Mercado Pago real en entorno de pruebas.

## Fuentes consultadas
- NICE CG103: https://www.nice.org.uk/guidance/cg103/chapter/Recommendations
- CDC, medidas de frecuencia: https://archive.cdc.gov/www_cdc_gov/csels/dsepd/ss1978/lesson3/section2.html
- CDC, epidemiología analítica: https://archive.cdc.gov/www_cdc_gov/csels/dsepd/ss1978/lesson1/section7.html
- Mercado Pago, creación de preferencia: https://www.mercadopago.com.ar/developers/es/reference/online-payments/checkout-pro-preferences/create-preference/post
- Mercado Pago, consulta por external_reference: https://www.mercadopago.com.ar/developers/es/docs/shopify/how-tos/change-endpoint-to-get-payment-details

Comprobación en la página publicada: menú simplificado, tres casos visibles, decisión incorrecta con devolución y pregunta contextual al tutor. La IA respondió correctamente distinguiendo sensibilidad de VPP. Se añadió formato seguro para negritas y fracciones simples tras observar que el proveedor enviaba marcado sin renderizar. /api/offer confirmó piloto abierto y pagos desactivados; /api/account/me confirmó cuentas configuradas.

## Webhook y conciliación de Mercado Pago (P0-3, parcial)
- `POST /api/payments/webhook`: autenticado con la firma `x-signature` (HMAC-SHA256 del manifiesto `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`) usando `MERCADOPAGO_WEBHOOK_SECRET`. Sin secreto configurado, toda notificación se rechaza (401). La notificación nunca se toma como prueba de pago: el pago se vuelve a consultar a la API y pasa las mismas verificaciones de referencia, vendedor, moneda e importe que la verificación manual.
- Idempotencia: `payment_id` es único y repetir la notificación no extiende la vigencia. Un reintegro o contracargo retira la vigencia.
- `POST /api/admin/payments/reconcile` (solo rol admin): reconsulta órdenes pendientes o vigentes con más de 5 minutos sin actualizar.
- Pendiente (requiere autorización del titular): crear la aplicación en Mercado Pago, cargar `MERCADOPAGO_WEBHOOK_SECRET`, registrar la URL `https://<dominio>/api/payments/webhook` con el evento «Pagos», probar con credenciales sandbox y recién entonces `CLINICIA_PAYMENTS_ENABLED=true`. No se ejecutaron pagos reales ni sandbox. El webhook corre en el servidor Node (Render); la función de Netlify no lo expone.
