// Create the map
const map = L.map("map", { preferCanvas: true }).setView(
    [45.5019, -73.5674],
    10
);

// Add a basemap
L.tileLayer('https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png', {
  minZoom: 0,
  maxZoom: 20,
  attribution: '&copy; <a href="https://www.stadiamaps.com/" target="_blank">Stadia Maps</a> &copy; <a href="https://openmaptiles.org/" target="_blank">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);

// ==================================================
// SETTINGS AND SHARED VARIABLES
// ==================================================
const HEX_ZOOM = 12;         // hexagons from this zoom
const POINT_ZOOM = 15;       // individual worksites from this zoom

// Dot size grows as you zoom past POINT_ZOOM
function getPointRadius(zoom) {
    return Math.max(5, 5 + (zoom - POINT_ZOOM) * 3);   // 5 px at zoom 15, 8 at 16, 11 at 17, 14 at 18...
}

let focusedBorough = null;   // the borough in focus, or null
let greyLayer = L.layerGroup();   // greys out the other boroughs (rebuilt on each focus)              // greys out the other boroughs
// Search bar: find an address and zoom to it
let searchMarker;

let focusOutline = null;      // white outline around the borough in focus

// Linked cities (Westmount, Pointe-Claire, ...) are separate municipalities:
// the City of Montréal's worksite data doesn't cover them
const NO_DATA_COLOR = "#4a4a4a";
function isLinkedCity(feature) {
    return feature.properties.TYPE !== "Arrondissement";
}
// ==================================================
// A3: MONTH SLIDER (shared settings)
// ==================================================
const FIRST_MONTH = "2025-01";   // first month on the slider
const LAST_MONTH  = "2027-12";   // last month on the slider

// HISTORY: the current month, e.g. "2026-11" (from the visitor's computer clock)
const today = new Date();
const NOW_MONTH = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
let currentMonth = NOW_MONTH;    // the map opens on the current month

// HISTORY: limits of the data, explained under the slider
const TRACKING_START = "2026-09";   // the history starts with the Sept 25, 2026 download
const KNOWN_GAPS = {
    "2026-10": "Not tracked between Sept 25 and Nov 18, 2026, so October is undercounted."
};

let allWorksites;                // all worksites, set when the data loads
let hexGeoLayer;                 // the hexagons, so we can recolour them
let worksiteGeoLayer, worksiteData;   // the dots, so we can filter them

// HISTORY: is this worksite active in the chosen month?
// - Current month: only what the City still lists today
// - Past months: started by then and not ended yet. If the City no longer lists it,
//   it ended at the latest when we last saw it (even if its planned end is later).
function isActive(p, month) {
    const start = (p.start_date || "").slice(0, 7);   // "2026-03-15" -> "2026-03"
    if (!start || start > month) return false;

    if (month === NOW_MONTH) return p.listed !== false;

    let end = (p.end_date || "").slice(0, 7);
    if (p.listed === false && p.last_seen) {
        const seen = p.last_seen.slice(0, 7);
        if (!end || seen < end) end = seen;
    }
    return !end || month <= end;
}

// HISTORY: where a worksite stands today (for the dot style and popup)
function statusOf(p) {
    if (p.listed === false) return "ended";
    if ((p.start_date || "").slice(0, 7) > NOW_MONTH) return "planned";
    return "active";
}

// EXTENSIONS: count worksites active in a month, counting a renewed worksite once
// (a permit and its renewal can overlap by a few days)
function countActive(list, month) {
    const seen = new Set();
    list.forEach(w => {
        const p = w.properties;
        if (isActive(p, month)) seen.add(p.chain_id || p.permit_id);
    });
    return seen.size;
}

// EXTENSIONS: "Oct 16, 2026" from "2026-10-16"
function shortDate(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" });
}

// "November 2026" from "2026-11"
function monthLabel(month) {
    const [y, m] = month.split("-").map(Number);
    return new Date(y, m - 1).toLocaleDateString("en-CA", { month: "long", year: "numeric" });
}

// Load a JSON file, and treat a missing or broken file as an error
function loadJSON(url) {
    return fetch(url).then(r => {
        if (!r.ok) throw new Error(`${url} could not load (${r.status})`);
        return r.json();
    });
}

// Tell the reader the data failed, instead of showing a blank map
function showDataError(err) {
    console.error(err);

    if (document.querySelector(".data-error")) return;   // only one message

    const box = L.DomUtil.create("div", "data-error", map.getContainer());
    box.setAttribute("role", "alert");
    box.innerHTML = `
        <strong>The construction data could not load.</strong><br>
        Check your internet connection and refresh the page.
        If it still doesn't work, the Ville de Montréal open data
        may be temporarily unavailable.
    `;

    const text = document.getElementById("month-text");
    if (text) text.textContent = "Data unavailable.";
}

L.Control.geocoder({
    defaultMarkGeocode: false,
    placeholder: "Search an address in Montréal...",
    geocoder: L.Control.Geocoder.photon({
        geocodingQueryParams: {
            bbox: "-73.98,45.40,-73.47,45.70",
            lang: "fr"
        }
    }),
    suggestMinLength: 3,
    suggestTimeout: 300
})
.on("markgeocode", function(e) {
    const place = e.geocode.center;

    // Remove the previous search marker, if any
    if (searchMarker) map.removeLayer(searchMarker);

    // Zoom in and mark the address
    map.setView(place, 16);
    searchMarker = L.marker(place).addTo(map)
        .bindPopup(e.geocode.name)
        .openPopup();
})
.addTo(map);

// Legend Box in Bottom Left Corner

const legend = L.control({ position: "bottomright" });

legend.onAdd = function() {
    this.div = L.DomUtil.create("div", "legend");
    return this.div;
};

legend.addTo(map);

// Fill the legend for the current zoom level
function updateLegend(level) {
    let title, rows;

    if (level === "borough") {
        title = "Worksites per km²";
        rows = [
            ["#800026", "14 or more"],
            ["#BD0026", "11 to 13"],
            ["#FC4E2A", "8 to 10"],
            ["#FD8D3C", "5 to 7"],
            ["#FED976", "Under 5"],
            ["#D9D9D9", "None"],
            [NO_DATA_COLOR, "Separate municipality (no data)"]
        ];
    } else {
        title = "Worksites per hexagon";
        rows = [
            ["#800026", "20 or more"],
            ["#BD0026", "11 to 19"],
            ["#FC4E2A", "6 to 10"],
            ["#FD8D3C", "3 to 5"],
            ["#FED976", "1 to 2"],
            ["#D9D9D9", "None"],
            [NO_DATA_COLOR, "Separate municipality (no data)"]
        ];
    }

    let focusedBorough = null;   // the borough in focus, or null
    
    let greyLayer;               // greys out the other boroughs
    let html = `<strong>${title}</strong>`;
    rows.forEach(([color, label]) => {
        html += `<div><i style="background:${color}"></i>${label}</div>`;
    });

    // At the closest zoom, also explain the dots
    if (level === "points") {
        html += `<div><i class="dot dot-active"></i>Active worksite</div>`;
        html += `<div><i class="dot dot-ended"></i>Permit ended</div>`;
             html += `<div><i class="dot dot-extended"></i>Permit renewed</div>`;
    }

    

    legend.div.innerHTML = html;

}

// Layer for the hexagons
const hexagonLayer = L.featureGroup();
let boroughFillLayer, boroughOutlineLayer;

// Load the Montréal boundary AND construction worksites
Promise.all([
    loadJSON("data/montreal_boundary.geojson"),
    loadJSON("data/worksites_history.geojson"),
    loadJSON("data/montreal_boroughs.geojson")
])
    .then(([boundaryData, worksites, boroughData]) => {

        // Use the boundary to calculate the extent
        const bbox = turf.bbox(boundaryData);

        // Create 500 m hexagons
        const hexGrid = turf.hexGrid(
            bbox,
            0.5,
            { units: "kilometers" }
        );

         // Fit the hexagons to the island:
        // - hexagons fully on land are kept whole
        // - hexagons crossing the shoreline are clipped to the borough shapes
        // - hexagons fully in the water are dropped
        const boroughBoxes = boroughData.features.map(b => turf.bbox(b));

        function boxesOverlap(a, b) {
            return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
        }

        function onLand(point, candidates) {
            return candidates.some(b => turf.booleanPointInPolygon(point, b));
        }

        const fittedHexagons = [];

        hexGrid.features.forEach(hex => {
            const hexBox = turf.bbox(hex);

            // Only test boroughs that are near this hexagon (much faster)
            const nearby = boroughData.features.filter((b, i) =>
                boxesOverlap(hexBox, boroughBoxes[i])
            );
            if (nearby.length === 0) return;   // nowhere near Montréal

            // Are all 6 corners and the center on land?
            const corners = hex.geometry.coordinates[0].slice(0, 6);
            const points = [...corners, turf.centroid(hex).geometry.coordinates];
            const landCount = points.filter(p => onLand(turf.point(p), nearby)).length;

            if (landCount === points.length) {
                fittedHexagons.push(hex);         // fully on land: keep whole
                return;
            }

            // Crosses the shoreline: clip it to the boroughs it touches
            try {
                let clipped = null;
                nearby.forEach(borough => {
                    const piece = turf.intersect(hex, borough);
                    if (!piece) return;
                    clipped = clipped ? turf.union(clipped, piece) : piece;
                });
                if (clipped) {
                    clipped.properties = { ...hex.properties };
                    fittedHexagons.push(clipped);
                }
            } catch (err) {
                // If clipping fails for one hexagon, keep it whole instead of breaking the map
                if (landCount > 0) fittedHexagons.push(hex);
            }
        });

        const montrealHexagons = turf.featureCollection(fittedHexagons);

        // Mark the hexagons whose center is in a linked city (no open data there)
        const linkedCities = boroughData.features.filter(isLinkedCity);
        montrealHexagons.features.forEach(hex => {
            const center = turf.centroid(hex);
            const city = linkedCities.find(c => turf.booleanPointInPolygon(center, c));
            hex.properties.linkedCity = city ? city.properties.NOM : null;
        });

        // Count worksites and calculate density for each borough
        allWorksites = worksites;

        boroughData.features.forEach(borough => {
            const p = borough.properties;
            p.worksiteList = worksites.features.filter(w =>
                turf.booleanPointInPolygon(w, borough)
            );
            p.areaKm2 = turf.area(borough) / 1000000;
            p.count = p.worksiteList.length;
            p.density = p.count / p.areaKm2;
        });

        // Coloured, clickable boroughs (far view)
        // Linked cities (separate municipalities) have no open construction data,
        // so they're drawn dark grey and can't be clicked
        boroughFillLayer = L.geoJSON(boroughData, {
            style: feature => isLinkedCity(feature)
                ? {
                    color: "#ffffff",
                    weight: 1,
                    fillColor: NO_DATA_COLOR,
                    fillOpacity: 0.85
                }
                : {
                    color: "#ffffff",
                    weight: 1,
                    fillColor: getBoroughColor(feature.properties.density),
                    fillOpacity: 0.7
                },
            onEachFeature: (feature, layer) => {
                const p = feature.properties;

                // Linked city: hover notice only
                if (isLinkedCity(feature)) {
                    layer.bindTooltip(`
                        <strong>${p.NOM}</strong><br>
                        Separate municipality<br>
                        <em>No open construction data</em>
                    `, { sticky: true });
                    return;
                }

                // Hover: show the borough's numbers
                layer.bindTooltip(() => `
                    <strong>${p.NOM}</strong><br>
                    ${p.count} worksites<br>
                    ${p.density.toFixed(1)} per km²
                `, { sticky: true });

                // Highlight the borough under the mouse
                layer.on("mouseover", () => {
                    layer.setStyle({ fillOpacity: 0.95, weight: 3, color: "#ffffff" });
                    layer.bringToFront();   // so its border isn't hidden by neighbours
                });
                layer.on("mouseout", () => boroughFillLayer.resetStyle(layer));
                // Click: focus on this borough
                layer.on("click", () => focusOn(feature));
            }
        });

        // Thin outlines that don't block clicks (closer views)
        boroughOutlineLayer = L.geoJSON(boroughData, {
            style: { color: "#555", weight: 1, fill: false },
            interactive: false

        });

        // Covers the boroughs that are NOT in focus
        greyLayer = L.geoJSON(boroughData, {
            style: { stroke: false, fillColor: "#999", fillOpacity: 0 },
            interactive: false   
        });

function getBoroughColor(density) {
    if (density >= 14) return "#800026";
    if (density >= 11) return "#BD0026";
    if (density >= 8)  return "#FC4E2A";
    if (density >= 5)  return "#FD8D3C";
    if (density >= 1)  return "#FED976";
    if (density >= 0)  return "#D9D9D9";
    return "#D9D9D9";
}

 // Count worksites inside each hexagon
    montrealHexagons.features.forEach(hex => {
        hex.properties.worksiteList = worksites.features.filter(w =>
            turf.booleanPointInPolygon(w, hex)
        );
        hex.properties.project_count = hex.properties.worksiteList.length;
    });

        // Draw the hexagons with color based on # of worksites
hexGeoLayer = L.geoJSON(montrealHexagons, {
    style: function(feature) {
        return {
            color: "#fff",
            weight: 0.5,
            // Color depends on # of worksites in the hexagon (dark grey = no data)
            fillColor: hexFill(feature.properties),
            fillOpacity: 0.7
        };
    },
    onEachFeature: function(feature, layer) {
        // Hexagon in a linked city: hover notice instead of a count
        if (feature.properties.linkedCity) {
            layer.bindTooltip(`
                <strong>${feature.properties.linkedCity}</strong><br>
                Separate municipality<br>
                <em>No open construction data</em>
            `, { sticky: true });
        } else {
            layer.bindPopup(() => {
                const n = feature.properties.project_count;
                return `<strong>${n} worksite${n === 1 ? "" : "s"}</strong> in this hexagon`;
            });
        }

        // If a borough is in focus and you click a hexagon in ANOTHER borough,
        // switch the focus to that borough instead of showing the popup
        layer.on("click", e => {
            if (!focusedBorough) return;
            const clicked = boroughAt(e.latlng);
            if (clicked && clicked !== focusedBorough) {
                map.closePopup();
                focusOn(clicked);
            }
        });
    }
    
}).addTo(hexagonLayer);

                updateLayers();
        applyMonth();     // HISTORY: count and colour everything for the current month
    })
    .catch(showDataError);

function getHexColor(count) {

    if (count >= 20) return "#800026";
    if (count >= 11) return "#BD0026";
    if (count >= 6)  return "#FC4E2A";
    if (count >= 3)  return "#FD8D3C";
    if (count >= 1)  return "#FED976";
    if (count === 0) return "#D9D9D9";

    return "#FFF7BC";

}

// Fill colour for one hexagon: dark grey in linked cities, otherwise by count
function hexFill(p) {
    return p.linkedCity ? NO_DATA_COLOR : getHexColor(p.project_count);
}

// ==================================================
// WORKSITE POPUP: WHAT IT BLOCKS FOR CITIZENS
// ==================================================
// Plain-language labels for the impact codes written by scripts/update_data.py
const ROAD_LABELS = {
    closed: "Street closed",
    lane_and_parking: "Traffic lane and parking blocked",
    lane: "Traffic lane blocked",
    parking: "Parking lane blocked",
    none: "Road not affected"
};
const SIDEWALK_LABELS = {
    closed: "Sidewalk closed",
    narrowed: "Sidewalk partly blocked (a path is kept)",
    none: "Sidewalk open"
};
const BIKE_LABELS = {
    closed: "Bike path closed",
    narrowed: "Bike path partly blocked"
};

// How serious an impact is, for the coloured marker: high, medium or low
function severity(code) {
    if (code === "closed") return "high";
    if (code === "none" || !code) return "low";
    return "medium";
}

// One line: coloured marker + text
function impactLine(code, text) {
    return `<li class="impact impact-${severity(code)}">${text}</li>`;
}

// The "What it blocks" part of the popup
function impactSection(p) {
    // Older worksites or permits without details from the City
    if (!p.impact_road && !p.impact_sidewalk) {
        return `<div class="impacts-none">No details from the City on what it blocks.</div>`;
    }

    const lines = [];
    if (p.impact_road) lines.push(impactLine(p.impact_road, ROAD_LABELS[p.impact_road] || p.impact_road));
    if (p.impact_sidewalk) lines.push(impactLine(p.impact_sidewalk, SIDEWALK_LABELS[p.impact_sidewalk] || p.impact_sidewalk));
    if (BIKE_LABELS[p.impact_bike]) lines.push(impactLine(p.impact_bike, BIKE_LABELS[p.impact_bike]));
    if (p.impact_bus) lines.push(impactLine("moved", "Bus stop moved"));

    const streets = (p.impact_streets || []).map(s => `<li>${s}</li>`).join("");

    return `
        <div class="impacts-title">What it blocks</div>
        <ul class="impacts">${lines.join("")}</ul>
        ${streets ? `<div class="impacts-title">Where</div><ul class="streets">${streets}</ul>` : ""}
    `;
}

// HISTORY: one line saying where the worksite stands today
function statusLine(p) {
    const status = statusOf(p);
    if (status === "ended") {
        return `<div class="status status-ended">Permit ended (last listed ${p.last_seen})</div>`;
    }
    if (status === "planned") {
        return `<div class="status status-planned">Planned: starts ${p.start_date}</div>`;
    }
    return `<div class="status status-active">Active</div>`;
}

// EXTENSIONS: what happened with the permits at this spot, if this permit is part of a chain.
// A permit gives the right to OCCUPY the street until its end date. A renewal means the
// occupation continued under a new permit: it can be a planned next phase or a delay.
function extensionLine(p) {
    if (!p.chain_id || !(p.chain_size > 1)) return "";
    const likely = p.chain_confidence === "medium";
    const renewals = p.chain_size - 1;
    const times = `${renewals} time${renewals === 1 ? "" : "s"}`;

    // Repeated short permits (the first one was under 7 days)
    if (p.chain_type === "repeated_short") {
        return `<div class="extension extension-short">
            ${likely ? "Likely repeated" : "Repeated"} short permits here since ${shortDate(p.chain_start)}
            (${p.chain_size} permits)</div>`;
    }

    // An earlier permit in the chain: it was followed by a new one
    if (p.chain_position < p.chain_size) {
        return `<div class="extension">${likely ? "Likely renewed" : "Renewed"}: the street occupation
            continued under a new permit</div>`;
    }

    // The latest permit: first end, current (or last) end, and how long the street has been occupied
    const DAY = 1000 * 60 * 60 * 24;
    const start = new Date(p.chain_start);
    const ended = p.listed === false;

    // Finished: it ended at its planned end, or earlier if the City stopped listing it
    let endDate = p.end_date;
    if (ended && p.last_seen && p.last_seen < endDate) endDate = p.last_seen;
    const until = ended ? new Date(endDate) : new Date();

    return `<div class="extension">
        <strong>Street occupation ${likely ? "likely continued" : "continued"} under a new permit</strong><br>
        First permit ended: ${shortDate(p.original_end)}<br>
        ${ended ? "Last permit ended" : "Now occupied until"}: ${shortDate(endDate)} (renewed ${times})<br>
        ${ended
            ? `Occupied from ${shortDate(p.chain_start)} to ${shortDate(endDate)}`
            : `Occupied since ${shortDate(p.chain_start)}`}
        (${duration((until - start) / DAY)})<br>
        <span class="extension-note">A renewal can be a planned next phase or a delay.</span>
    </div>`;
}

// EXTENSIONS: "3 days", "2 weeks" or "4 months"
function duration(days) {
    if (days < 14) return `${Math.max(1, Math.round(days))} day${Math.round(days) <= 1 ? "" : "s"}`;
    if (days < 60) return `${Math.round(days / 7)} weeks`;
    return `${Math.round(days / 30.44)} months`;
}

// Full popup for one worksite
function worksitePopup(p) {
    return `
        <strong>${p.reason || "Worksite"}</strong><br>
        Organization: ${p.organization || "Not specified"}<br>
        Borough: ${p.borough}<br>
        From ${p.start_date} to ${p.end_date}
        ${statusLine(p)}
        ${extensionLine(p)}
        ${impactSection(p)}
    `;
}

// HISTORY: dot style for each status
const DOT_STYLES = {
    active:  { color: "#b35900", fillColor: "#ff8c00", fillOpacity: 0.8, weight: 1 },   // solid orange
    ended:   { color: "#888888", fillColor: "#bbbbbb", fillOpacity: 0.45, weight: 1 },  // faded grey
    planned: { color: "#ff8c00", fillColor: "#ff8c00", fillOpacity: 0, weight: 2 }      // hollow orange ring
};

// EXTENSIONS: dark red ring around worksites whose permit was renewed
const EXTENDED_RING = { color: "#800026", weight: 3 };

function dotStyle(p) {
    const style = { ...DOT_STYLES[statusOf(p)] };
    if (p.chain_type === "extended") Object.assign(style, EXTENDED_RING);
    return style;
}

// Code for zoom in precise location of construction

const projectLayer = L.layerGroup();

// Load the worksites and add them as pins with popups

loadJSON("data/worksites_history.geojson")
    .then(data => {
        worksiteData = data;
        worksiteGeoLayer = L.geoJSON(data, {
            filter: feature => isActive(feature.properties, currentMonth),

            // Draw each worksite as a circle instead of a pin
            pointToLayer: (feature, latlng) => {
                return L.circleMarker(latlng, {
                    radius: getPointRadius(map.getZoom()),
                    ...dotStyle(feature.properties)   // HISTORY: active / ended / planned + EXTENSIONS ring
                });
            },

            // Attach a popup to each circle, with the "rate the impact" panel underneath
            onEachFeature: (feature, layer) => {
                const p = feature.properties;
                layer.bindPopup(() => {
                    const div = document.createElement("div");
                    div.innerHTML = worksitePopup(p);
                    if (window.createRatingPanel) {
                        div.appendChild(window.createRatingPanel(p.permit_id));
                    }
                    return div;
                });
            }
        }).addTo(projectLayer);
    })
    .catch(showDataError);

    // Zoom Fuctionality Features
function updateLayers() {
    if (!boroughFillLayer) return;

    const zoom = map.getZoom();

    [boroughFillLayer, boroughOutlineLayer, hexagonLayer, projectLayer, greyLayer]
        .forEach(layer => map.removeLayer(layer));

    if (zoom < HEX_ZOOM && focusedBorough === null) {
        // Far, not focused: boroughs
        map.addLayer(boroughFillLayer);
        updateLegend("borough");
        

    } else if (zoom < POINT_ZOOM) {
        // Hexagons (always, when a borough is in focus)
        hexagonLayer.setStyle({ fillOpacity: 0.7, color: "#fff", weight: 0.5 });
        map.addLayer(hexagonLayer);
        if (focusedBorough) map.addLayer(greyLayer);
        map.addLayer(boroughOutlineLayer);
        updateLegend("hexagon");

    } else {
    // Close: faded hexagons + worksites
    hexagonLayer.setStyle({ fillOpacity: 0.15, color: "#555", weight: 2 });
    if (worksiteGeoLayer) worksiteGeoLayer.eachLayer(l => l.setRadius(getPointRadius(zoom)));   // NEW
    map.addLayer(hexagonLayer);
    map.addLayer(projectLayer);
    if (focusedBorough) map.addLayer(greyLayer);
       map.addLayer(boroughOutlineLayer);
    updateLegend("points");
}

    // Keep the focus outline on top of everything else
    if (focusOutline) {
        map.removeLayer(focusOutline);
        map.addLayer(focusOutline);
    }
}

//  function updateLayers() {
//     if (!boroughFillLayer) return;   // data not loaded yet

//     const zoom = map.getZoom();

//     // Start from a clean map
//     [boroughFillLayer, boroughOutlineLayer, hexagonLayer, projectLayer]
//         .forEach(layer => map.removeLayer(layer));

//     if (zoom < 12) {
//         // Far: boroughs by worksites per km²
//         map.addLayer(boroughFillLayer);
//         updateLegend("borough");

//     } else if (zoom < 15) {
//         // Middle: hexagons + borough lines
//         hexagonLayer.setStyle({ fillOpacity: 0.7, color: "#fff", weight: 0.5 });
//         map.addLayer(hexagonLayer);
//         map.addLayer(boroughOutlineLayer);
//         updateLegend("hexagon");        

//     } else {
//         // Close: faded hexagons + borough lines + worksites
//         hexagonLayer.setStyle({ fillOpacity: 0.50, color: "#555", weight: 2 });
//         map.addLayer(hexagonLayer);
//         map.addLayer(boroughOutlineLayer);
//         map.addLayer(projectLayer);
//         updateLegend("points");       
//     }
// }

map.on("zoomend", updateLayers);

// Hide the focus outline during zoom animations (the canvas stretches lines while animating)
map.on("zoomstart", () => { if (focusOutline) map.removeLayer(focusOutline); });

// ==================================================
// 9. FOCUS MODE: CLICK A BOROUGH TO ZOOM IN ON IT
// ==================================================
const focusPanel = L.control({ position: "topleft" });

focusPanel.onAdd = function() {
    this.div = L.DomUtil.create("div", "focus-panel");
    L.DomEvent.disableClickPropagation(this.div);  // clicks on the panel don't reach the map
    this.div.style.display = "none";               // hidden until a borough is clicked
    return this.div;
};

focusPanel.addTo(map);

// Find which borough contains a clicked point (or null if none)
function boroughAt(latlng) {
    const pt = turf.point([latlng.lng, latlng.lat]);
    let found = null;
    boroughFillLayer.eachLayer(l => {
        if (turf.booleanPointInPolygon(pt, l.feature)) found = l.feature;
    });
    return found;
}

function focusOn(feature) {
    if (isLinkedCity(feature)) return;   // no data to focus on
    focusedBorough = feature;

    // Grey out every borough except this one
    greyLayer.setStyle(f => ({ fillOpacity: f === focusedBorough ? 0 : 0.6 }));


    // White outline with a dark halo around the borough in focus
    if (focusOutline) map.removeLayer(focusOutline);
    focusOutline = L.layerGroup([
        L.geoJSON(feature, {   // dark halo underneath, so the white line shows on light hexagons too
            style: { color: "#000", weight: 4, opacity: 0.45, fill: false },
            interactive: false
        }),
        L.geoJSON(feature, {   // white line on top
            style: { color: "#fff", weight: 3.5, opacity: 1, fill: false },
            interactive: false
        })
    ]);

    map.flyToBounds(L.geoJSON(feature).getBounds(), { padding: [20, 20], duration: 0.8 });
    updateFocusPanel();
    updateLayers();
}

function exitFocus() {
    focusedBorough = null;
    greyLayer.setStyle({ fillOpacity: 0 });
    if (focusOutline) map.removeLayer(focusOutline);
    focusOutline = null;
    focusPanel.div.style.display = "none";
    map.setView([45.55, -73.65], 11), {duration: 0.8};
    updateLayers();
}

// EXTENSIONS: how many worksites in this borough are extended, for the selected month
function extendedInBorough(p) {
    const chains = new Set();
    p.worksiteList.forEach(w => {
        const q = w.properties;
        if (q.chain_type === "extended" && isActive(q, currentMonth)) chains.add(q.chain_id);
    });
    if (chains.size === 0) return "";
    return `<div class="focus-extended"><b>${chains.size}</b> with a renewed permit</div>`;
}

function updateFocusPanel() {
    if (!focusedBorough) return;

    const p = focusedBorough.properties;
    focusPanel.div.innerHTML = `
        <div class="focus-name">${p.NOM}</div>
        <div class="focus-stats">
            <span><b>${p.count}</b> worksites</span>
            <span><b>${p.density.toFixed(1)}</b> per km²</span>
        </div>
        ${extendedInBorough(p)}
        <button id="back-button">← Back to all of Montréal</button>
        <div class="focus-hint">Click another borough to switch · Esc to exit</div>
    `;
    focusPanel.div.style.display = "block";
    document.getElementById("back-button").addEventListener("click", exitFocus);
}

// Press Esc to leave focus mode
document.addEventListener("keydown", e => {
    if (e.key === "Escape" && focusedBorough) exitFocus();
});

// Click outside Montréal (river, off-island) to leave focus mode
map.on("click", e => {
    if (focusedBorough && !boroughAt(e.latlng)) exitFocus();
});

// ==================================================
// A3: MONTH SLIDER
// ==================================================
// Slider positions: FIRST_MONTH ... LAST_MONTH (HISTORY: no "all months" position)
function buildMonths() {
    const list = [];
    let [y, m] = FIRST_MONTH.split("-").map(Number);
    while (true) {
        const key = `${y}-${String(m).padStart(2, "0")}`;
        if (key > LAST_MONTH) break;
        list.push(key);
        m++;
        if (m > 12) { m = 1; y++; }
    }
    return list;
}
const months = buildMonths();
const nowIndex = Math.max(0, months.indexOf(NOW_MONTH));   // slider position of the current month

const monthControl = L.control({ position: "bottomleft" });
monthControl.onAdd = function() {
    const div = L.DomUtil.create("div", "month-control");
    div.innerHTML = `
        <label for="month-slider"><strong>When is construction happening?</strong></label>
        <input type="range" id="month-slider" min="0" max="${months.length - 1}" value="${nowIndex}" step="1">
        <div class="month-row">
            <div id="month-text" aria-live="polite">Loading…</div>
            <button id="now-button" type="button">Now</button>
        </div>
        <div id="month-note" class="month-note"></div>
    `;
    L.DomEvent.disableClickPropagation(div);    // dragging the slider doesn't drag the map
    L.DomEvent.disableScrollPropagation(div);
    return div;
};
monthControl.addTo(map);

// EVENT: the reader moves the slider
document.getElementById("month-slider").addEventListener("input", e => {
    // HANDLER: remember which month they chose
    currentMonth = months[Number(e.target.value)];
    // UPDATE: recount, recolour, refilter, rewrite the text
    applyMonth();
});

// EVENT: HISTORY: back to the current month
document.getElementById("now-button").addEventListener("click", () => {
    document.getElementById("month-slider").value = nowIndex;
    currentMonth = NOW_MONTH;
    applyMonth();
});

function applyMonth() {
    if (!allWorksites) return;   // data not loaded yet

    // Recount and recolour the boroughs
    boroughFillLayer.eachLayer(layer => {
        const p = layer.feature.properties;
        p.count = countActive(p.worksiteList, currentMonth);   // EXTENSIONS: renewals counted once
        p.density = p.count / p.areaKm2;
        boroughFillLayer.resetStyle(layer);
    });

    // Recount and recolour the hexagons
    hexGeoLayer.eachLayer(layer => {
        const p = layer.feature.properties;
         p.project_count = countActive(p.worksiteList, currentMonth);
        layer.setStyle({ fillColor: hexFill(p) });
        if (layer.isPopupOpen()) layer.getPopup().update();   // NEW: refresh an open popup
    });

    // Redraw only this month's worksites as dots
    if (worksiteGeoLayer) {
        worksiteGeoLayer.clearLayers();
        worksiteGeoLayer.addData(worksiteData);
    }

    updateFocusPanel();   // the borough panel shows counts too
    updateMonthText();
}

function updateMonthText() {
    const text = document.getElementById("month-text");
    if (!allWorksites) return;

    const isNow = currentMonth === NOW_MONTH;
    const label = monthLabel(currentMonth) + (isNow ? " (now)" : "");
    const n = countActive(allWorksites.features, currentMonth);

    text.innerHTML = n === 0
        ? `No active worksites in ${label}. Try another month.`
        : `<strong>${n}</strong> worksite${n === 1 ? "" : "s"} ${isNow ? "active" : "in"} ${label}`;

    document.getElementById("now-button").disabled = isNow;

    // HISTORY: explain the limits of the data for some months
    let note = "";
    if (currentMonth < TRACKING_START) {
        note = `History is tracked since ${monthLabel(TRACKING_START)}. Earlier months only show
                worksites that were still active then, so they look emptier than they were.`;
    } else if (KNOWN_GAPS[currentMonth]) {
        note = KNOWN_GAPS[currentMonth];
    } else if (currentMonth > NOW_MONTH) {
        note = "Future months only show permits already issued.";
    }
    document.getElementById("month-note").innerHTML = note;
}

// ==================================================
// SIDEBAR TOGGLE
// ==================================================
const appContainer = document.querySelector(".app-container");
const sidebar = document.querySelector(".sidebar");
const toggleButton = document.getElementById("sidebar-toggle");

toggleButton.addEventListener("click", () => {
    const closed = appContainer.classList.toggle("sidebar-closed");
    toggleButton.textContent = closed ? "‹" : "›";
});

// After the slide, let Leaflet fill the new space
sidebar.addEventListener("transitionend", () => map.invalidateSize());