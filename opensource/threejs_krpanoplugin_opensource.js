/*
	krpano ThreeJS Plugin - 'Open Source' Version

	This is a simplified and stripped down version of the krpano ThreeJS Plugin.
	It shows how the renderer and hittest integration works and how to use 3D Models as hotspots.
*/

function krpanoplugin()
{
	var local = this;

	var pluginname = "ThreeJS Open Source Plugin";

	var krpano = null;
	var plugin = null;

	// array of all krpano ThreeJS hotspots
	var krpano_threejs_hotspots = [];

	// krpano and ThreeJS are using different size units
	var KRPANO_TO_THREEJS_SCALE = 0.01;		// 1^=1cm in krpano, 1^=100cm in ThreeJS


	local.registerplugin = function(krpanointerface, pluginpath, pluginobject)
	{
		// get the krpano interface and the plugin object
		krpano = krpanointerface;
		plugin = pluginobject;

		if (parseFloat(krpano.version) < 1.22)
		{
			krpano.actions.error(pluginname + " - Too old krpano version (min. 1.22)");
			return;
		}

		if (!krpano.webGL)
		{
			krpano.actions.error(pluginname + " - WebGL required!");
			return;
		}

		// make the plugin available as global 'threejs' variable
		krpano.threejs = plugin;

		// state settings
		plugin.isready = false;

		// core plugin settings (need to be set at startup)
		plugin.registerattribute("integratedrendering", true);

		// setup the plugin layer to be 'fullscreen'
		plugin.align = plugin.edge = "lefttop";
		plugin.x = 0;
		plugin.y = 0;
		plugin.width = "100%";
		plugin.height = "100%";
		plugin.safearea = false;
		plugin.capture = false;
		plugin.handcursor = false;
		plugin.zorder = -10000000;
		plugin.enabled = false;

		// startup - load/import ThreeJS and the GLTFLoader
		// NOTE - there need to be an 'importmap' for these modules in the html file!
		import_modules(["three", "BufferGeometryUtils", "GLTFLoader"], threejs_start);
	}


	function import_modules(modulenames, callback)
	{
		var promises = [];
		var modules = {};
		var i;

		for (i=0; i < modulenames.length; i++)
		{
			promises.push( import(modulenames[i]).catch(function(err)
			{
				// no importmap or missing module entry
				krpano.actions.error(pluginname + " - " + err);
			}));
		}

		Promise.all(promises).then(function(loadedmodules)
		{
			var okay = true;

			for (i=0; i < modulenames.length; i++)
			{
				var module = loadedmodules[i];
				if (module)
				{
					modules[ modulenames[i] ] = module;
				}
				else
				{
					okay = false;
					krpano.actions.error(pluginname + " - Missing module: "+modulenames[i]);
				}
			}

			if (okay)
			{
				callback(modules);
			}
		});
	}


	// function references for removing on unload
	var f_hittest = null;
	var f_renderframe = null;
	var f_onviewchange = null;

	local.unloadplugin = function()
	{
		krpano_threejs_hotspots.slice().forEach( function(hs)
		{
			hs.remove();
		});

		krpano.registerType("threejs", null);

		if (f_onviewchange)
		{
			krpano.events.removeListener("onviewchange", f_onviewchange);
			f_onviewchange = null;
		}

		if (f_renderframe)
		{
			krpano.webGL.removeListener("renderframe", f_renderframe);
			f_renderframe = null;
		}

		if (f_hittest)
		{
			krpano.webGL.removeListener("hittest", f_hittest);
			f_hittest = null;
		}

		var renderer = plugin.renderer;

		if (renderer)
		{
			if (plugin.integratedrendering == false && plugin.sprite && renderer.domElement )
			{
				plugin.sprite.removeChild( renderer.domElement );
			}

			renderer.dispose();

			plugin.renderer = renderer = null;
		}

		delete krpano.threejs;
		delete window.__THREE__;
	}



	// all ThreeJS related code inside here
	function threejs_start(modules)
	{
		var THREE      = modules["three"];
		var GLTFLoader = modules["GLTFLoader"].GLTFLoader;

		var renderer;
		var scene = new THREE.Scene();
		var camera = new THREE.PerspectiveCamera();
		var raycaster = new THREE.Raycaster();
		var ambientlight = null;

		// some temporary helper objects
		var euler = new THREE.Euler();
		var mx1 = new THREE.Matrix4();
		var mx2 = new THREE.Matrix4();
		var quat1 = new THREE.Quaternion();
		

		// create the ThreeJS renderer
		if (plugin.integratedrendering)
		{
			// krpano interated rendering, shared WebGL context and frame/depthbuffers
			renderer = new THREE.WebGLRenderer({canvas:krpano.webGL.canvas, context:krpano.webGL.context});
			renderer.autoClear = false;		// krpano will clear the canvas!
		}
		else
		{
			// no rendering integration, render on top of krpano / as plugin sprite
			renderer = new THREE.WebGLRenderer({ antialias:true });

			plugin.sprite.appendChild( renderer.domElement );

			renderer.setClearColor(0xFFFFFF, 0);
			renderer.setPixelRatio(window.devicePixelRatio);
			renderer.setSize(window.innerWidth, window.innerHeight);
		}

		// export the ThreeJS objects to the krpano plugin object
		plugin.THREE = THREE;
		plugin.renderer = renderer;
		plugin.scene = scene;
		plugin.camera = camera;
		plugin.raycaster = raycaster;
		
		// some helper functions
		plugin.krpano_to_threejs_position = krpano_to_threejs_position;
		plugin.threejs_to_krpano_position = threejs_to_krpano_position;
		plugin.krpano_to_threejs_rotation = krpano_to_threejs_rotation;
		plugin.threejs_to_krpano_rotation = threejs_to_krpano_rotation;

		// some default renderer settings
		renderer.shadowMap.enabled = true;
		renderer.shadowMap.type = THREE.PCFShadowMap;
		renderer.toneMapping = THREE.NoToneMapping;
		renderer.useLegacyLights = false;

		// block the fisheye rendering during ThreeJS usage
		f_onviewchange = krpano.events.addListener("onviewchange", function()
		{
			krpano.view.fisheye = 0;
		});


		// add support for: <hotspot ... type="threejs" url="model.glb" ...
		krpano.registerType("threejs", function(hs, url, callback)
		{
			if (url == null)
			{
				//console.log(hs.path, "unload threejs model");

				var removeindex = krpano_threejs_hotspots.indexOf(hs);
				if (removeindex >= 0)
				{
					krpano_threejs_hotspots.splice(removeindex,1);
				}

				var model = hs.threejsobject;

				if (model)
				{
					model.kobject = null;
					scene.remove( model );
				}
				
				delete hs.threejsobject;
				delete hs.set_threejs_pose;
				delete hs.get_threejs_pose;

				// request render
				krpano.view.haschanged = true;
			}
			else
			{
				//console.log(hs.path, "load threejs model:",url);

				var urlinfo = krpano.utils.spliturl(url);

				var ext = urlinfo.ext.toLowerCase();

				var loader = null;
				if (ext == "gltf" || ext == "glb")
				{
					loader = new GLTFLoader().setPath( urlinfo.path );
				}
				else
				{
					callback(false, "- not supported file format");
				}

				if (loader)
				{
					loader.load(urlinfo.filename, function ( gltf )
					{
						var model = gltf.scene;
						scene.add( model );

						krpano_threejs_hotspots.push(hs);

						// crosslink ThreeJS and krpano
						model.name = hs.path;
						hs.threejsobject = model;
						model.kobject = hs;
						
						// APIs for manual pose converion
						hs.set_threejs_pose = function(){ krpano_to_threejs_hotspot_pose(hs); }
						hs.get_threejs_pose = function(){ threejs_to_krpano_hotspot_pose(hs); }

						// set initial position
						krpano_to_threejs_hotspot_pose(hs);

						// enable shadows
						model.castShadow = true;
						model.receiveShadow = true;
						model.traverse(function(o){ if(o.isMesh){ o.castShadow = model.castShadow; o.receiveShadow = model.receiveShadow; }});

						callback(true);

						// request render
						krpano.view.haschanged = true;
					});
				}
			}
		});


		// intersectVisibleObjects
		// - a custom function for intersecting objects and their childrens - but only visible ones!
		// - the ThreeJS function 'raycaster.intersectObjects' intersects also invisible objects
		function intersectVisibleObjects(objects, raycaster, intersects, skipsorting)
		{
			var i, cnt=objects.length, object;

			for (i=0; i < cnt; i++)
			{
				object = objects[i];
				if (object.visible)
				{
					if (object.isMesh)
					{
						object.raycast(raycaster, intersects);
					}

					intersectVisibleObjects(object.children, raycaster, intersects, true);
				}
			}

			if (skipsorting !== true)
			{
				intersects.sort(function(a,b){ return a.distance - b.distance; });
			}
		}


		// search for a related 'kobject' (ThreeJS and krpano crosslink) in the ThreeJS object
		function find_kobject(obj)
		{
			var kobject = obj.kobject;
			var parent = obj.parent;
			if (kobject == null && parent)
			{
				kobject = find_kobject(parent);
			}
			return kobject;
		}


		// hit-testing
		f_hittest = krpano.webGL.addListener("hittest", function(eventtype, origin, dir, hitobj, hittesthotspots)
		{
			raycaster.ray.origin.set(origin.z*KRPANO_TO_THREEJS_SCALE, -origin.y*KRPANO_TO_THREEJS_SCALE, origin.x*KRPANO_TO_THREEJS_SCALE);
			raycaster.ray.direction.set(-dir.x, -dir.y, dir.z).normalize();

			var i;
			var models_to_check;

			if (eventtype == "raycast")
			{
				// raycast - check all geometry for collision
				models_to_check = scene.children;
			}
			else
			{
				// no raycast - check only the visible and enabled hotspots
				models_to_check = [];

				for (i=0; i < krpano_threejs_hotspots.length; i++)
				{
					var hs = krpano_threejs_hotspots[i];
					if (hs.visible && hs.enabled)
					{
						var model = hs.threejsobject;
						if (model)
						{
							models_to_check.push(model);
						}
					}
				}
			}

			// check
			var intersects = [];
			intersectVisibleObjects(models_to_check, raycaster, intersects);

			var havehit = false;

			for (i=0; i < intersects.length; i++)
			{
				var hit = intersects[i];
				var hit_d = hit.distance / KRPANO_TO_THREEJS_SCALE;

				// first hit or a hit with a shorter distance?
				if (hitobj.d < 0 || (hit_d < hitobj.d))
				{
					hitobj.d = hit_d;

					hitobj.x = +hit.point.z / KRPANO_TO_THREEJS_SCALE;
					hitobj.y = -hit.point.y / KRPANO_TO_THREEJS_SCALE;
					hitobj.z = +hit.point.x / KRPANO_TO_THREEJS_SCALE;

					var n = hit.normal;
					if (n)
					{
						n = n.clone().transformDirection( hit.object.matrixWorld );
						hitobj.nx = +n.z;
						hitobj.ny = -n.y;
						hitobj.nz = +n.x;
					}
					else
					{
						hitobj.nx = hitobj.ny = hitobj.nz = 0;
					}

					// is the hit on a hotspot?
					hitobj.hs = find_kobject(hit.object);

					// mode=4 means a customtype hit (not needed, just for info)
					hitobj.mode = 4;

					havehit = true;

					break;
				}
			}

			return havehit;
		});


		// helper
		var M_DEG2RAD = Math.PI / 180.0;

		// convert a krpano ath/atv/depth + tx/ty/tz position to a ThreeJS x,y,z position
		function krpano_to_threejs_position(p, h,v,d, x,y,z)
		{
			if (d != 0)
			{
				h *= M_DEG2RAD;
				v *= M_DEG2RAD;

				var cosv = Math.cos(v);

				x += d * cosv*Math.sin(h);
				z += d * cosv*Math.cos(h);
				y += d * Math.sin(v);
			}
			
			if (p == null) p = {x:0, y:0, z:0};

			p.x = +z * KRPANO_TO_THREEJS_SCALE;
			p.y = -y * KRPANO_TO_THREEJS_SCALE;
			p.z = +x * KRPANO_TO_THREEJS_SCALE;
			
			return p;
		}
		
		// arguments - either:
		// - one object with x,y,z properties 
		// - one array with 3 values
		// - or x,y,z as values
		function threejs_to_krpano_position()
		{
			var x,y,z;
			
			if (arguments.length == 1)
			{
				var p = arguments[0];
				if ( Array.isArray(p) )
				{
					x = p[0];
					y = p[1];
					z = p[2];
				}
				else
				{
					x = p.x;
					y = p.y;
					z = p.z;
				}
			}
			else if (arguments.length == 3)
			{
				x = arguments[0];
				y = arguments[1];
				z = arguments[2];
			}
			
			return {
					x : +z / KRPANO_TO_THREEJS_SCALE,
					y : -y / KRPANO_TO_THREEJS_SCALE,
					z : +x / KRPANO_TO_THREEJS_SCALE
				};
		}

		// convert a krpano rotation-order to a ThreeJS rotation-order, e.g. "xyz" to "ZYX"
		function krpano_to_threejs_rotationorder(r)
		{
			r = r.toUpperCase();		// make uppercase
			r = r[2] + r[1] + r[0];		// and reverse the character order
			return r;
		}
		
		// convert krpano hotspot rotation settings to a ThreeJS Quaternion
		// note - uses the temporary euler,mx1,mx2 helper objects!
		function krpano_to_threejs_rotation(quaternion, h, v, roll, rx, ry, rz, rotationorder)
		{
			mx1.makeRotationFromEuler( euler.set(rx * M_DEG2RAD, -ry * M_DEG2RAD, -rz * M_DEG2RAD, krpano_to_threejs_rotationorder(rotationorder)) );
			mx2.makeRotationFromEuler( euler.set(-v * M_DEG2RAD, (-h-90) * M_DEG2RAD, -roll * M_DEG2RAD, "YXZ") );
			mx1.premultiply(mx2);
			
			quaternion.setFromRotationMatrix(mx1);
			
			return quaternion;
		}
		
		// convert a ThreeJS Quaternion to krpano hotspot rx,ry,rz rotation values
		// note - uses the temporary euler,mx1,mx2 helper objects!
		function threejs_to_krpano_rotation(quaternion, h, v, roll, rotationorder)
		{
			mx1.makeRotationFromQuaternion( quaternion );
			mx2.makeRotationFromEuler( euler.set(-v * M_DEG2RAD, (-h-90) * M_DEG2RAD, -roll * M_DEG2RAD, "YXZ") );
			mx2.invert();
			mx1.premultiply(mx2);
			
			euler.setFromRotationMatrix(mx1, krpano_to_threejs_rotationorder(rotationorder));
			
			return {
				x : +euler.x / M_DEG2RAD,
				y : -euler.y / M_DEG2RAD,
				z : -euler.z / M_DEG2RAD
			};
		}
		
		// convert the krpano hotspot position and rotation settings to the ThreeJS model
		function krpano_to_threejs_hotspot_pose(hs)
		{
			var model = hs.threejsobject;

			// scale
			model.scale.set(hs.scalex, hs.scaley, hs.scalez);

			// position
			krpano_to_threejs_position(model.position, hs.ath, hs.atv, hs.depth, hs.tx, hs.ty, hs.tz);
			
			// rotation
			krpano_to_threejs_rotation(model.quaternion, hs.ath, hs.atv, hs.rotate, hs.rx, hs.ry, hs.rz, hs.rotationorder);
		}
		
		// convert the current ThreeJS model position and rotation settings to a krpano hotspot
		function threejs_to_krpano_hotspot_pose(hs)
		{
			var model = hs.threejsobject;
			
			// scale
			hs.scalex = model.scale.x;
			hs.scaley = model.scale.y;
			hs.scalez = model.scale.z;
			
			// position
			var p;
			if (hs.depth != 0)
			{
				var p1 = model.position;
				var p2 = krpano_to_threejs_position(null, hs.ath, hs.atv, hs.depth, 0,0,0);
				p = threejs_to_krpano_position(p1.x-p2.x, p1.y-p2.y, p1.z-p2.z);
			}
			else
			{
				p = threejs_to_krpano_position(model.position);
			}
			hs.tx = p.x;
			hs.ty = p.y;
			hs.tz = p.z;
			
			// rotation
			var r = threejs_to_krpano_rotation(model.quaternion, hs.ath, hs.atv, hs.rotate, hs.rotationorder);
			hs.rx = r.x;
			hs.ry = r.y;
			hs.rz = r.z;
		}


		// rendering
		f_renderframe = krpano.webGL.addListener("renderframe", function(fb, viewport, pano, panoview, stereo)
		{
			if (plugin.integratedrendering)
			{
				// reset the ThreeJS renderer state
				renderer.resetState();

				// ensure to always render to the current krpano framebuffer
				krpano.webGL.redirectBackbuffer(true, fb, stereo);

				renderer.setViewport(viewport[0],viewport[1],viewport[2],viewport[3]);
			}
			else
			{
				renderer.setSize(plugin.sprite.clientWidth, plugin.sprite.clientHeight);

				var s = window.devicePixelRatio > 0 ? 1 / window.devicePixelRatio : 1;
				renderer.setViewport(viewport[0]*s, viewport[1]*s, viewport[2]*s, viewport[3]*s);
			}


			// setup the camera
			camera.quaternion.setFromEuler( euler.set(panoview.v * M_DEG2RAD, -(panoview.h-90) * M_DEG2RAD, panoview.r * M_DEG2RAD, "YXZ") );
			if (panoview.rx != 0 || panoview.ry != 0){ quat1.setFromEuler( euler.set(panoview.rx * M_DEG2RAD, -panoview.ry * M_DEG2RAD, 0, "YXZ") ); camera.quaternion.multiply(quat1); };
			camera.scale.set(-KRPANO_TO_THREEJS_SCALE, -KRPANO_TO_THREEJS_SCALE, KRPANO_TO_THREEJS_SCALE);
			camera.position.set(panoview.tz*KRPANO_TO_THREEJS_SCALE, -panoview.ty*KRPANO_TO_THREEJS_SCALE, panoview.tx*KRPANO_TO_THREEJS_SCALE);
			camera.updateMatrixWorld(true);

			// add the view offsets for 'dollhouse' views
			camera.matrixWorldAutoUpdate = false;
			mx1.makeTranslation(krpano.view.ox, -krpano.view.oy, -krpano.view.oz);
			camera.matrixWorld.multiply(mx1);
			camera.matrixWorldInverse.copy( camera.matrixWorld ).invert();

			// set the camera/view projection
			var m = krpano.webGL.projectionMatrix;
			camera.projectionMatrix.set(m[0],m[4],m[8],m[12], m[1],m[5],m[9],m[13], m[2],m[6],m[10],m[14], m[3],m[7],m[11],m[15]);
			camera.projectionMatrixInverse.copy( camera.projectionMatrix ).invert();

			// update the hotspots
			var cnt = krpano_threejs_hotspots.length;
			var i;

			for (i=0; i < cnt; i++)
			{
				var hs = krpano_threejs_hotspots[i];

				// update the current visibility state
				hs.threejsobject.visible = hs.visible;

				// changed hotspot settings?
				if (hs.needredraw)
				{
					krpano_to_threejs_hotspot_pose(hs);

					hs.needredraw = false;		// clear the needredraw flag after updating
				}
			}


			// do the actual ThreeJS rendering
			krpano.events.dispatch("threejs_onbeforerender");

			renderer.render(scene, camera);

			krpano.events.dispatch("threejs_onafterrender");


			if (plugin.integratedrendering)
			{
				// restore the framebuffers redirection
				krpano.webGL.redirectBackbuffer(false);

				// for some reason ThreeJS needs another resetState() call here to ensure correct rendering...?
				renderer.resetState();

				// restore the krpano WebGL states
				krpano.webGL.resetState();
			}
		});


		// setup done, start user control
		plugin.isready = true;
		krpano.events.dispatch("threejs_onready");
		plugin.triggerevent("onready");
	}
}
