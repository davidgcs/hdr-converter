export const translations = {
  en: {
    PAGE_TITLE: "HDR Converter — HDR to SDR images",
    META_DESCRIPTION: "Convert HDR AVIF images to shareable SDR images locally in your browser.",
    APP_SUBTITLE: "Local HDR to SDR conversion for images that look right everywhere.",
    QUICK_GUIDE:
      "Open an HDR image, crop it if you need to, press convert and download the SDR result. Everything stays in your browser.",
    LOCAL_BADGE: "Processed in your browser",
    GITHUB_KICKER: "Open source · Built by",
    GITHUB_PROFILE_LABEL: "View @davidgcs on GitHub",
    GITHUB_REPOSITORY_CTA: "See code",
    GITHUB_REPOSITORY_LABEL: "See the HDR Converter source code on GitHub",
    DARK_THEME_LABEL: "Switch to dark theme",
    LIGHT_THEME_LABEL: "Switch to light theme",
    LANGUAGE_LABEL: "Language",
    CONTROLS_LABEL: "Conversion controls",
    OPEN_FILE: "Open images",
    ADD_FILES: "Add images",
    CONVERT: "Convert",
    CLEAR: "Clear",
    CROP_ENABLE: "Crop",
    CROP_DISABLE: "Done cropping",
    CROP_RESET: "Reset crop",
    ASPECT_LABEL: "Crop ratio",
    ASPECT_ORIGINAL: "Original",
    ASPECT_FREE: "Free",
    ASPECT_SQUARE: "1:1",
    ASPECT_16_9: "16:9",
    ASPECT_4_3: "4:3",
    ASPECT_3_2: "3:2",
    SETTINGS_TITLE: "Conversion settings",
    TONEMAP_LABEL: "Tone mapping",
    TONEMAP_NONE: "None",
    TONEMAP_LINEAR: "Linear",
    TONEMAP_GAMMA: "Gamma",
    TONEMAP_CLIP: "Clip",
    TONEMAP_REINHARD: "Reinhard",
    TONEMAP_HABLE: "Hable (filmic)",
    TONEMAP_BT2390: "BT.2390 (recommended)",
    TONEMAP_MOBIUS: "Mobius (FFmpeg)",
    BRIGHTNESS_LABEL: "Brightness",
    BRIGHTNESS_AUTO: "Auto exposure",
    BRIGHTNESS_REFERENCE: "Reference white (203 nits)",
    BRIGHTNESS_STANDARD: "Faithful (recommended)",
    PEAK_LABEL: "Source peak brightness",
    PEAK_AUTO: "Auto (measured)",
    PEAK_STANDARD: "Format standard",
    PEAK_CUSTOM: "Custom",
    PEAK_NITS_LABEL: "Peak nits",
    DESAT_LABEL: "Highlight desaturation",
    FORMAT_LABEL: "Output format",
    FORMAT_JPEG: "JPEG",
    FORMAT_PNG: "PNG",
    FORMAT_WEBP: "WebP",
    QUALITY_LABEL: "Quality",
    ADVANCED_SUMMARY: "Advanced settings",
    PARAM_LABEL: "Curve parameter",
    PARAM_AUTO: "FFmpeg default",
    EXPOSURE_LABEL: "Exposure (stops)",
    MAXDIM_LABEL: "Limit longest side (px)",
    MAXDIM_ORIGINAL: "Original size",
    INPUT_LABEL: "Read source as",
    INPUT_AUTO: "Auto (file tagging)",
    INPUT_PQ: "HDR10 / PQ BT.2020",
    INPUT_HLG: "HLG BT.2020",
    INPUT_SDR: "SDR sRGB",
    RESET_SETTINGS: "Restore defaults",
    RESET_SETTINGS_TITLE:
      "Put every setting back to the recommended baseline for a normal HDR photo.",
    SOURCE_TITLE: "Source (HDR)",
    RESULT_TITLE: "Result (SDR)",
    EMPTY_SOURCE: "No image loaded.",
    EMPTY_RESULT: "Convert an image to see the SDR result.",
    OPEN_TAB: "Open in new tab",
    DOWNLOAD: "Download",
    CLOSE: "Close",
    RESET: "Reset",
    ADJUST: "Adjust the image",
    ADJUST_TITLE: "Adjust image",
    ADJUST_RESET: "Reset adjustments",
    ADJUST_NOTE:
      "Edits apply straight away, at full quality, to this image only. Click the picture to see it without edits, or hold it. Double-click a slider to reset it.",
    UNDO: "Undo",
    REDO: "Redo",
    NOISE_LABEL: "Noise reduction",
    ADJUST_PEEK: "Show the picture without your edits: click for a moment, or hold",
    ADJUST_PEEK_TAG: "Without edits",
    CONTRAST_LABEL: "Contrast",
    HIGHLIGHTS_LABEL: "Highlights",
    SHADOWS_LABEL: "Shadows",
    WHITES_LABEL: "White point",
    BLACKS_LABEL: "Black point",
    SATURATION_LABEL: "Saturation",
    ADJUST_GROUP_LIGHT: "Light",
    ADJUST_GROUP_COLOR: "Color",
    ADJUST_GROUP_DETAIL: "Detail",
    ADJUST_GROUP_EFFECTS: "Effects",
    TEMPERATURE_LABEL: "Temperature",
    TINT_LABEL: "Tint",
    VIBRANCE_LABEL: "Vibrance",
    CLARITY_LABEL: "Clarity",
    SHARPNESS_LABEL: "Sharpness",
    VIGNETTE_LABEL: "Vignette",
    COMPARE: "Compare with the original",
    COMPARE_TITLE: "Before and after",
    COMPARE_BEFORE: "Original (HDR)",
    COMPARE_AFTER: "Converted (SDR)",
    COMPARE_SLIDER: "Move to wipe between the two images",
    COMPARE_NOTE:
      "The left side is how this device already renders the HDR file — the same thing another screen or a messaging app would show.",
    TIP_TONEMAP:
      "How light brighter than the SDR screen can show is fitted into range. BT.2390, the ITU standard, reproduces every tone that fits exactly as it was, rolls off only what is brighter, and keeps shadow detail above the screen's black. Mobius is FFmpeg's default, Hable is filmic but darker, and Clip simply cuts anything too bright.",
    TIP_BRIGHTNESS:
      "How HDR brightness becomes SDR brightness. Faithful shows each tone at the same light level it had in the HDR file, with 100 nits as SDR white, so a dark scene stays as dark as it was made. Reference white follows BT.2408 and is half as bright. Auto exposure re-exposes every scene to the same level, which lifts dark scenes and changes their look.",
    TIP_PEAK:
      "The brightest level assumed to exist in the source. It sets how much headroom the curve has to compress, so a higher value protects highlights but flattens contrast.",
    TIP_PEAK_NITS: "The peak brightness to assume, in nits.",
    TIP_DESAT:
      "Pulls very bright pixels towards grey. 0 keeps every colour exactly as measured, which is the faithful result; FFmpeg uses 2. Raise it only if bright lamps or skies look oddly tinted.",
    TIP_FORMAT:
      "The file you download. JPEG is 8-bit sRGB with an embedded sRGB profile, the best choice for WhatsApp, Instagram and the web. PNG is 16-bit sRGB and uncompressed, for archiving the full precision; it is large. WebP sits in between.",
    TIP_QUALITY:
      "JPEG and WebP compression, applied only when you download. The picture you edit stays lossless. Higher keeps more detail and makes a bigger file; below about 80 you may see blocking in smooth gradients.",
    TIP_ASPECT:
      "Constrains the crop box. Original keeps the proportions of the source, so the result is never stretched.",
    TIP_INPUT:
      "Overrides how the source is interpreted. Use it only when a file is tagged wrongly and the result looks washed out or far too dark.",
    TIP_PARAM:
      "Fine-tunes the selected curve. Leave it empty for the standard value: the BT.2390 knee offset of 0.5, or the FFmpeg default for the other curves.",
    TIP_EXPOSURE:
      "Brightens or darkens the whole image before tone mapping, in camera stops. +1 doubles the light, -1 halves it. It stacks on top of the Brightness setting.",
    TIP_CONTRAST:
      "Separates light from dark around mid grey. Pure black and pure white never move, so raising it deepens shadows and brightens highlights without clipping either end.",
    TIP_HIGHLIGHTS:
      "Only the bright tones, leaving midtones and shadows alone. Lower it to bring back detail in a blown sky or a lamp; raise it to make bright areas glow more.",
    TIP_SHADOWS:
      "Only the dark tones. Raise it to open up detail hidden in shadow without washing out the rest of the picture. Pure black stays black either way.",
    TIP_WHITES:
      "Where white begins. Raising it makes more of the brightest tones pure white, which adds punch but loses the detail above the new point.",
    TIP_BLACKS:
      "Where black begins. Lowering it crushes the deepest tones to true black for a denser look; raising it fades them to grey, the way film does.",
    TIP_SATURATION:
      "How far colours sit from grey. 0 leaves the converted colours exactly as measured, which is the faithful result; move it only if you want a more or less vivid look.",
    TIP_TEMPERATURE:
      "White balance, as on a camera: right makes the light warmer and more golden, left cooler and bluer. Greys keep their brightness; only the colour of the light changes.",
    TIP_TINT:
      "Removes a green or magenta cast: right adds magenta, left adds green. Use it after Temperature when whites still look off.",
    TIP_VIBRANCE:
      "A gentler saturation: it lifts muted colours first and leaves vivid ones alone, so a dull sky gains colour before signs or skin tones turn garish. Left mutes the dull colours first.",
    TIP_NOISE:
      "Smooths grain and coloured speckle while keeping edges and texture. Colour noise, the blotchy kind in dark scenes, goes first. It runs before Clarity and Sharpness, so they do not sharpen the noise back.",
    TIP_CLARITY:
      "Local contrast in the midtones: brings out texture and depth without making blacks or whites harsher. Strong outlines are left alone, so it does not draw halos. Left softens the picture.",
    TIP_SHARPNESS:
      "Crisps fine edges, like a camera's sharpening, at the size of the downloaded file. Tiny differences are ignored so gradients and noise are not exaggerated. While you drag it is approximated; letting go shows the exact result.",
    TIP_VIGNETTE:
      "Left darkens the corners to draw the eye to the centre; right lightens them. The shape follows the frame, crop included.",
    TIP_MAXDIM:
      "Shrinks the downloaded file so its longest side fits this many pixels. The picture you edit stays full size, and the aspect ratio is always preserved.",
    DOWNLOAD_ALL: "Download all",
    INITIAL_STATUS: "Open an HDR image (AVIF, HEIF, JPEG, PNG or WebP) to begin.",
    LOADING: "Decoding image…",
    IMAGE_LOADED: "{name} loaded — {width}×{height}, {depth}-bit {transfer}.",
    IMAGES_LOADED: "{count} images loaded. Select one to crop it.",
    DECODE_ERROR: "That file could not be decoded: {message}",
    CONVERTING: "Converting…",
    CONVERTED: "Converted to SDR — {width}×{height}, detected peak {nits} nits.",
    CONVERT_ERROR: "The conversion failed: {message}",
    CROP_INSTRUCTION: "Drag the selection or its corners to choose the area to keep.",
    CROP_RESET_DONE: "Crop reset to the full image.",
    CROP_APPLIED: "Crop applied: {width}×{height} px.",
    CROP_SUMMARY: "Crop: {width}×{height} px ({ratio}).",
    NO_HDR_DATA:
      "Your browser cannot hand over the raw HDR samples, so the image was read after the browser converted it. Chrome or Edge give accurate results.",
    UNTAGGED_SOURCE: "This file has no HDR tagging, so it is treated as SDR sRGB. You can override it in the advanced settings.",
    QUEUE_LABEL: "Loaded images",
    QUEUE_REMOVE: "Remove {name}",
    IMAGE_REMOVED: "{name} removed from the list.",
    RESULT_NOTE: "{width}×{height} · saved as {format} when you download",
    FORMAT_PNG_16: "PNG, 16-bit",
    EXPORTING: "Preparing {name}…",
    EXPORT_ERROR: "Could not save the image: {message}",
    NOTHING_TO_UNDO: "Nothing to undo.",
    NOTHING_TO_REDO: "Nothing to redo."
  },
  es: {
    PAGE_TITLE: "HDR Converter — Imágenes HDR a SDR",
    META_DESCRIPTION: "Convierte imágenes HDR AVIF en imágenes SDR listas para compartir, en tu navegador.",
    APP_SUBTITLE: "Conversión local de HDR a SDR para imágenes que se ven bien en cualquier sitio.",
    QUICK_GUIDE:
      "Abre una imagen HDR, recórtala si lo necesitas, pulsa convertir y descarga el resultado SDR. Todo ocurre en tu navegador.",
    LOCAL_BADGE: "Procesado en tu navegador",
    GITHUB_KICKER: "Código abierto · Creado por",
    GITHUB_PROFILE_LABEL: "Ver @davidgcs en GitHub",
    GITHUB_REPOSITORY_CTA: "Ver código",
    GITHUB_REPOSITORY_LABEL: "Ver el código de HDR Converter en GitHub",
    DARK_THEME_LABEL: "Cambiar al tema oscuro",
    LIGHT_THEME_LABEL: "Cambiar al tema claro",
    LANGUAGE_LABEL: "Idioma",
    CONTROLS_LABEL: "Controles de conversión",
    OPEN_FILE: "Abrir imágenes",
    ADD_FILES: "Añadir imágenes",
    CONVERT: "Convertir",
    CLEAR: "Limpiar",
    CROP_ENABLE: "Recortar",
    CROP_DISABLE: "Recorte listo",
    CROP_RESET: "Reiniciar recorte",
    ASPECT_LABEL: "Proporción",
    ASPECT_ORIGINAL: "Original",
    ASPECT_FREE: "Libre",
    ASPECT_SQUARE: "1:1",
    ASPECT_16_9: "16:9",
    ASPECT_4_3: "4:3",
    ASPECT_3_2: "3:2",
    SETTINGS_TITLE: "Ajustes de conversión",
    TONEMAP_LABEL: "Mapeo de tonos",
    TONEMAP_NONE: "Ninguno",
    TONEMAP_LINEAR: "Lineal",
    TONEMAP_GAMMA: "Gamma",
    TONEMAP_CLIP: "Recorte",
    TONEMAP_REINHARD: "Reinhard",
    TONEMAP_HABLE: "Hable (fílmico)",
    TONEMAP_BT2390: "BT.2390 (recomendado)",
    TONEMAP_MOBIUS: "Mobius (FFmpeg)",
    BRIGHTNESS_LABEL: "Brillo",
    BRIGHTNESS_AUTO: "Exposición automática",
    BRIGHTNESS_REFERENCE: "Blanco de referencia (203 nits)",
    BRIGHTNESS_STANDARD: "Fiel (recomendado)",
    PEAK_LABEL: "Brillo máximo del origen",
    PEAK_AUTO: "Automático (medido)",
    PEAK_STANDARD: "Estándar del formato",
    PEAK_CUSTOM: "Personalizado",
    PEAK_NITS_LABEL: "Nits máximos",
    DESAT_LABEL: "Desaturación de altas luces",
    FORMAT_LABEL: "Formato de salida",
    FORMAT_JPEG: "JPEG",
    FORMAT_PNG: "PNG",
    FORMAT_WEBP: "WebP",
    QUALITY_LABEL: "Calidad",
    ADVANCED_SUMMARY: "Ajustes avanzados",
    PARAM_LABEL: "Parámetro de la curva",
    PARAM_AUTO: "Valor de FFmpeg",
    EXPOSURE_LABEL: "Exposición (pasos)",
    MAXDIM_LABEL: "Limitar lado mayor (px)",
    MAXDIM_ORIGINAL: "Tamaño original",
    INPUT_LABEL: "Interpretar origen como",
    INPUT_AUTO: "Automático (etiquetas)",
    INPUT_PQ: "HDR10 / PQ BT.2020",
    INPUT_HLG: "HLG BT.2020",
    INPUT_SDR: "SDR sRGB",
    RESET_SETTINGS: "Restablecer ajustes",
    RESET_SETTINGS_TITLE:
      "Devuelve todos los ajustes al punto de partida recomendado para una foto HDR normal.",
    SOURCE_TITLE: "Origen (HDR)",
    RESULT_TITLE: "Resultado (SDR)",
    EMPTY_SOURCE: "No hay ninguna imagen cargada.",
    EMPTY_RESULT: "Convierte una imagen para ver el resultado SDR.",
    OPEN_TAB: "Abrir en una pestaña nueva",
    DOWNLOAD: "Descargar",
    CLOSE: "Cerrar",
    RESET: "Restablecer",
    ADJUST: "Ajustar la imagen",
    ADJUST_TITLE: "Ajustar imagen",
    ADJUST_RESET: "Restablecer ajustes",
    ADJUST_NOTE:
      "Los ajustes se aplican al momento, con toda la calidad, solo a esta imagen. Haz clic en la imagen para verla sin ajustes, o mantenla pulsada. Haz doble clic en un control para restablecerlo.",
    UNDO: "Deshacer",
    REDO: "Rehacer",
    NOISE_LABEL: "Reducción de ruido",
    ADJUST_PEEK: "Ver la imagen sin tus ajustes: haz clic para verla un momento, o mantenla pulsada",
    ADJUST_PEEK_TAG: "Sin ajustes",
    CONTRAST_LABEL: "Contraste",
    HIGHLIGHTS_LABEL: "Luces",
    SHADOWS_LABEL: "Sombras",
    WHITES_LABEL: "Punto de blanco",
    BLACKS_LABEL: "Punto de negro",
    SATURATION_LABEL: "Saturación",
    ADJUST_GROUP_LIGHT: "Luz",
    ADJUST_GROUP_COLOR: "Color",
    ADJUST_GROUP_DETAIL: "Detalle",
    ADJUST_GROUP_EFFECTS: "Efectos",
    TEMPERATURE_LABEL: "Temperatura",
    TINT_LABEL: "Matiz",
    VIBRANCE_LABEL: "Intensidad",
    CLARITY_LABEL: "Claridad",
    SHARPNESS_LABEL: "Nitidez",
    VIGNETTE_LABEL: "Viñeta",
    COMPARE: "Comparar con la original",
    COMPARE_TITLE: "Antes y después",
    COMPARE_BEFORE: "Original (HDR)",
    COMPARE_AFTER: "Convertida (SDR)",
    COMPARE_SLIDER: "Desplaza para comparar las dos imágenes",
    COMPARE_NOTE:
      "La parte izquierda es como este dispositivo ya muestra el archivo HDR, lo mismo que vería otra pantalla o una aplicación de mensajería.",
    TIP_TONEMAP:
      "Cómo se encaja la luz que la pantalla SDR no puede mostrar. BT.2390, el estándar de la ITU, reproduce tal cual cada tono que cabe, comprime solo lo que es más brillante y conserva el detalle de las sombras por encima del negro de la pantalla. Mobius es el de FFmpeg, Hable es cinematográfico pero más oscuro y Clip simplemente recorta lo que sobra.",
    TIP_BRIGHTNESS:
      "Cómo se traduce el brillo HDR al brillo SDR. Fiel muestra cada tono con la misma luz que tenía en el archivo HDR, con 100 nits como blanco SDR, así que una escena oscura sigue tan oscura como se creó. El blanco de referencia sigue BT.2408 y queda la mitad de brillante. La exposición automática reexpone todas las escenas al mismo nivel, lo que aclara las oscuras y cambia su aspecto.",
    TIP_PEAK:
      "El nivel más brillante que se supone que existe en el origen. Define cuánto margen tiene la curva para comprimir: un valor alto protege las altas luces pero resta contraste.",
    TIP_PEAK_NITS: "Brillo máximo que se va a suponer, en nits.",
    TIP_DESAT:
      "Acerca al gris los píxeles muy brillantes. En 0 cada color se conserva tal y como se ha medido, que es el resultado fiel; FFmpeg usa 2. Súbelo solo si las lámparas o los cielos brillantes se ven teñidos.",
    TIP_FORMAT:
      "El archivo que vas a descargar. JPEG es sRGB de 8 bits con el perfil sRGB incrustado, lo mejor para WhatsApp, Instagram y la web. PNG es sRGB de 16 bits sin compresión, para archivar toda la precisión; ocupa mucho. WebP queda entre los dos.",
    TIP_QUALITY:
      "Compresión de JPEG y WebP, aplicada solo al descargar. La imagen que editas se mantiene sin pérdida. Más alto conserva más detalle y genera un archivo mayor; por debajo de 80 pueden verse bloques en los degradados.",
    TIP_ASPECT:
      "Limita el recuadro de recorte. Original mantiene las proporciones del archivo, así que el resultado nunca se deforma.",
    TIP_INPUT:
      "Cambia cómo se interpreta el origen. Úsalo solo cuando un archivo está mal etiquetado y el resultado sale lavado o demasiado oscuro.",
    TIP_PARAM:
      "Ajusta la curva seleccionada. Déjalo vacío para usar el valor estándar: el desplazamiento de rodilla 0,5 de BT.2390, o el valor por defecto de FFmpeg en las demás curvas.",
    TIP_EXPOSURE:
      "Aclara u oscurece toda la imagen antes del mapeo de tonos, en pasos de cámara. +1 duplica la luz y -1 la reduce a la mitad. Se suma al ajuste de Brillo.",
    TIP_CONTRAST:
      "Separa las luces de las sombras alrededor del gris medio. El negro y el blanco puros no se mueven, así que subirlo intensifica las sombras y aclara las luces sin quemar ninguno de los dos extremos.",
    TIP_HIGHLIGHTS:
      "Afecta solo a los tonos claros y deja intactos los medios y las sombras. Bájalo para recuperar detalle en un cielo quemado o en una lámpara; súbelo para que las zonas claras brillen más.",
    TIP_SHADOWS:
      "Afecta solo a los tonos oscuros. Súbelo para descubrir detalle escondido en las sombras sin deslavar el resto de la imagen. El negro puro sigue siendo negro en cualquier caso.",
    TIP_WHITES:
      "Dónde empieza el blanco. Subirlo convierte en blanco puro más tonos claros, lo que da fuerza pero pierde el detalle que quede por encima de ese punto.",
    TIP_BLACKS:
      "Dónde empieza el negro. Bajarlo lleva los tonos más oscuros a negro puro y da una imagen más densa; subirlo los aclara hacia el gris, como hace el cine.",
    TIP_SATURATION:
      "Cuánto se alejan los colores del gris. En 0 se conservan los colores tal y como se han medido, que es el resultado fiel; muévelo solo si quieres un aspecto más o menos vivo.",
    TIP_TEMPERATURE:
      "Balance de blancos, como en una cámara: a la derecha la luz se vuelve más cálida y dorada, a la izquierda más fría y azulada. Los grises conservan su brillo; solo cambia el color de la luz.",
    TIP_TINT:
      "Elimina un tono verde o magenta: a la derecha añade magenta, a la izquierda verde. Úsalo después de la Temperatura si los blancos siguen sin verse neutros.",
    TIP_VIBRANCE:
      "Una saturación más suave: aviva primero los colores apagados y deja en paz los intensos, así un cielo gris gana color antes de que los carteles o la piel se vean chillones. A la izquierda apaga primero los colores más débiles.",
    TIP_NOISE:
      "Suaviza el grano y las motas de color conservando los bordes y la textura. Primero desaparece el ruido de color, el de las manchas en las escenas oscuras. Se aplica antes que la Claridad y la Nitidez, para que no vuelvan a realzar el ruido.",
    TIP_CLARITY:
      "Contraste local en los tonos medios: resalta la textura y la profundidad sin endurecer los negros ni los blancos. Los contornos marcados no se tocan, así que no aparecen halos. A la izquierda suaviza la imagen.",
    TIP_SHARPNESS:
      "Define los bordes finos, como el enfoque de una cámara, al tamaño del archivo que descargas. Las diferencias diminutas se ignoran para no exagerar degradados ni ruido. Mientras arrastras se muestra aproximado; al soltar ves el resultado exacto.",
    TIP_VIGNETTE:
      "A la izquierda oscurece las esquinas para llevar la mirada al centro; a la derecha las aclara. La forma sigue el encuadre, recorte incluido.",
    TIP_MAXDIM:
      "Reduce el archivo descargado para que su lado más largo quepa en estos píxeles. La imagen que editas se mantiene a tamaño completo, y la proporción siempre se conserva.",
    DOWNLOAD_ALL: "Descargar todo",
    INITIAL_STATUS: "Abre una imagen HDR (AVIF, HEIF, JPEG, PNG o WebP) para empezar.",
    LOADING: "Decodificando imagen…",
    IMAGE_LOADED: "{name} cargada — {width}×{height}, {transfer} de {depth} bits.",
    IMAGES_LOADED: "{count} imágenes cargadas. Selecciona una para recortarla.",
    DECODE_ERROR: "No se pudo decodificar el archivo: {message}",
    CONVERTING: "Convirtiendo…",
    CONVERTED: "Convertida a SDR — {width}×{height}, pico detectado {nits} nits.",
    CONVERT_ERROR: "La conversión ha fallado: {message}",
    CROP_INSTRUCTION: "Arrastra la selección o sus esquinas para elegir el área que quieres conservar.",
    CROP_RESET_DONE: "Recorte reiniciado a la imagen completa.",
    CROP_APPLIED: "Recorte aplicado: {width}×{height} px.",
    CROP_SUMMARY: "Recorte: {width}×{height} px ({ratio}).",
    NO_HDR_DATA:
      "Tu navegador no entrega las muestras HDR originales, así que la imagen se leyó ya convertida por el navegador. Chrome o Edge dan resultados precisos.",
    UNTAGGED_SOURCE:
      "Este archivo no tiene etiquetas HDR, así que se trata como SDR sRGB. Puedes forzarlo en los ajustes avanzados.",
    QUEUE_LABEL: "Imágenes cargadas",
    QUEUE_REMOVE: "Quitar {name}",
    IMAGE_REMOVED: "{name} se ha quitado de la lista.",
    RESULT_NOTE: "{width}×{height} · se guarda como {format} al descargar",
    FORMAT_PNG_16: "PNG de 16 bits",
    EXPORTING: "Preparando {name}…",
    EXPORT_ERROR: "No se pudo guardar la imagen: {message}",
    NOTHING_TO_UNDO: "No hay nada que deshacer.",
    NOTHING_TO_REDO: "No hay nada que rehacer."
  }
};

export function createTranslator(getLanguage) {
  return function translate(key, params = {}) {
    const language = getLanguage();
    const dictionary = translations[language] || translations.en;
    const template = dictionary[key] ?? translations.en[key] ?? key;
    return Object.entries(params).reduce(
      (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
      template
    );
  };
}
