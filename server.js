const express = require('express');
const { WebSocketServer } = require('ws');
const geolib = require('geolib');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const WS_PORT = process.env.WS_PORT || 8080;

// Store driver locations and user requests
let drivers = {};
let users = {};
let rideRequests = {};
let driverRequests = {}; // Store driver requests to users

// Create WebSocket server
const wss = new WebSocketServer({ port: WS_PORT });

// Log active connections
console.log('Starting WebSocket server with debug logging enabled');

// Add connection tracking for debugging
let connectionCount = 0;
const logConnections = () => {
  console.log(`Active connections: ${connectionCount}`);
  console.log(`Active drivers: ${Object.keys(drivers).length}`);
  console.log(`Active users: ${Object.keys(users).length}`);
};

// Log active connections every 10 seconds
setInterval(logConnections, 10000);

wss.on('connection', (ws) => {
  connectionCount++;
  console.log(`New client connected (total: ${connectionCount})`);
  logConnections();
  
  // Send immediate connection confirmation
  ws.send(JSON.stringify({
    type: 'connectionStatus',
    status: 'connected',
    timestamp: new Date()
  }));
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      console.log('Received message:', data.type);
      
      // Validate required fields based on message type
      let isValid = true;
      let errorMessage = '';
      
      // Basic validation for all messages
      if (!data.type) {
        isValid = false;
        errorMessage = 'Message type is required';
      }
      
      // Specific validations based on message type
      if (data.type === 'requestRide' && data.role === 'user') {
        if (!data.userId) {
          isValid = false;
          errorMessage = 'userId is required for ride requests';
        }
        if (!data.rideId) {
          isValid = false;
          errorMessage = 'rideId is required for ride requests';
        }
        if (!data.data || !data.data.pickup || !data.data.dropoff) {
          isValid = false;
          errorMessage = 'pickup and dropoff are required for ride requests';
        }
        if (data.data && data.data.pickup && !data.data.pickup.coordinates) {
          isValid = false;
          errorMessage = 'pickup.coordinates is required for ride requests';
        }
      }
      
      if (!isValid) {
        console.error(`Invalid message: ${errorMessage}`, data);
        ws.send(JSON.stringify({
          type: 'error',
          message: errorMessage
        }));
        return;
      }
      
      // Handle driver location updates
      if (data.type === 'locationUpdate' && data.role === 'driver') {
        const driverId = data.driverId;
        
        drivers[driverId] = {
          ...drivers[driverId],
          id: driverId,
          ws,
          latitude: data.data.latitude,
          longitude: data.data.longitude,
          isAvailable: data.data.isAvailable
        };
        
        console.log(`Updated driver ${driverId} location:`, drivers[driverId]);
      }
      
      // Handle user connection
      if (data.type === 'connect' && data.role === 'user') {
        const userId = data.userId;
        
        users[userId] = {
          id: userId,
          ws
        };
        
        console.log(`User ${userId} connected`);
      }
      
      // Handle driver connection
      if (data.type === 'connect' && data.role === 'driver') {
        const driverId = data.driverId;
        
        drivers[driverId] = {
          id: driverId,
          ws,
          latitude: data.data?.latitude,
          longitude: data.data?.longitude,
          isAvailable: data.data?.isAvailable || false,
          name: data.data?.name || 'Driver',
          rating: data.data?.rating || 4.5,
          car: data.data?.car || 'Unknown Car',
          plate: data.data?.plate || 'Unknown Plate'
        };
        
        console.log(`Driver ${driverId} connected`);
      }
      
      // Handle ride requests from users
      if (data.type === 'requestRide' && data.role === 'user') {
        const userId = data.userId;
        const rideId = data.rideId;
        const pickup = data.data.pickup;
        const dropoff = data.data.dropoff;
        
        console.log(`Received ride request from user ${userId} with id ${rideId}`);
        console.log('Pickup:', JSON.stringify(pickup));
        console.log('Dropoff:', JSON.stringify(dropoff));
        
        // Validate and extract pickup coordinates
        let pickupLat, pickupLon;
        
        if (pickup && pickup.coordinates) {
          pickupLat = pickup.coordinates.latitude;
          pickupLon = pickup.coordinates.longitude;
          console.log(`Extracted coordinates: lat=${pickupLat}, lon=${pickupLon}`);
        } else {
          console.error('Invalid pickup coordinates structure:', pickup);
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Invalid pickup coordinates structure'
          }));
          return;
        }
        
        // Validate pickup coordinates values
        if (typeof pickupLat !== 'number' || typeof pickupLon !== 'number') {
          console.error('Invalid pickup coordinate values. Expected numbers:', { pickupLat, pickupLon });
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Invalid pickup coordinate values'
          }));
          return;
        }
        
        rideRequests[rideId] = {
          id: rideId,
          userId,
          pickup,
          dropoff,
          status: 'pending',
          createdAt: new Date(),
          driverRequests: [] // List of drivers who have sent requests for this ride
        };
        
        console.log('Available drivers before finding nearby:', Object.keys(drivers));
        
        // Find nearby available drivers using the validated coordinates
        const nearbyDrivers = findNearbyDrivers(pickupLat, pickupLon);
        
        console.log(`Found ${nearbyDrivers.length} nearby drivers for ride ${rideId}`);
        if (nearbyDrivers.length > 0) {
          console.log('Nearby driver IDs:', nearbyDrivers.map(d => d.id).join(', '));
        }
        
        // Notify user of nearby drivers (even if none are found)
        if (users[userId]) {
          users[userId].ws.send(
            JSON.stringify({
              type: 'nearbyDrivers',
              rideId,
              drivers: nearbyDrivers.map(driver => ({
                id: driver.id,
                latitude: driver.latitude,
                longitude: driver.longitude,
                distance: driver.distance
              }))
            })
          );
          
          // If no drivers are available, also send an error message
          if (nearbyDrivers.length === 0) {
            users[userId].ws.send(
              JSON.stringify({
                type: 'error',
                message: 'No drivers available in your area'
              })
            );
          }
        }
        
        // Notify nearby drivers of the ride request
        nearbyDrivers.forEach(driver => {
          if (drivers[driver.id]) {
            console.log(`Notifying driver ${driver.id} about ride request ${rideId}`);
            drivers[driver.id].ws.send(
              JSON.stringify({
                type: 'rideRequest',
                rideId,
                userId,
                pickup,
                dropoff
              })
            );
          }
        });
        
        console.log(`Ride ${rideId} requested by user ${userId}`);
      }
      
      // Handle driver sending request to user
      if (data.type === 'sendRideRequest' && data.role === 'driver') {
        const driverId = data.driverId;
        const rideId = data.rideId;
        const userId = data.userId;
        
        if (rideRequests[rideId] && rideRequests[rideId].status === 'pending') {
          // Add to ride driver requests
          if (!rideRequests[rideId].driverRequests.includes(driverId)) {
            rideRequests[rideId].driverRequests.push(driverId);
          }
          
          // Store the driver request
          driverRequests[`${rideId}_${driverId}`] = {
            rideId,
            driverId,
            userId,
            status: 'pending',
            createdAt: new Date()
          };
          
          // Get driver details
          const driver = drivers[driverId];
          
          // Ensure we have valid coordinates for ETA calculation
          let pickupLat = null;
          let pickupLng = null;
          
          if (rideRequests[rideId].pickup.coordinates) {
            pickupLat = rideRequests[rideId].pickup.coordinates.latitude;
            pickupLng = rideRequests[rideId].pickup.coordinates.longitude;
          }
          
          // Calculate ETA
          const eta = calculateETA(
            driver.latitude, 
            driver.longitude, 
            pickupLat, 
            pickupLng
          );
          
          // Notify user about the driver request
          if (users[userId]) {
            users[userId].ws.send(
              JSON.stringify({
                type: 'driverRequest',
                rideId,
                driverId,
                driver: {
                  name: driver.name,
                  rating: driver.rating,
                  car: driver.car,
                  plate: driver.plate,
                  latitude: driver.latitude,
                  longitude: driver.longitude,
                  eta: eta
                }
              })
            );
          }
          
          console.log(`Driver ${driverId} sent request for ride ${rideId} to user ${userId}`);
        }
      }
      
      // Handle user accepting a driver request
      if (data.type === 'acceptDriver' && data.role === 'user') {
        const userId = data.userId;
        const rideId = data.rideId;
        const driverId = data.driverId;
        
        const requestKey = `${rideId}_${driverId}`;
        
        if (driverRequests[requestKey] && driverRequests[requestKey].status === 'pending') {
          // Update driver request status
          driverRequests[requestKey].status = 'accepted';
          driverRequests[requestKey].acceptedAt = new Date();
          
          // Update ride request status
          if (rideRequests[rideId]) {
            rideRequests[rideId].status = 'accepted';
            rideRequests[rideId].driverId = driverId;
            rideRequests[rideId].acceptedAt = new Date();
          }
          
          // Notify the accepted driver
          if (drivers[driverId]) {
            drivers[driverId].ws.send(
              JSON.stringify({
                type: 'acceptedByUser',
                rideId,
                userId
              })
            );
          }
          
          // Notify other drivers who sent requests that they were not selected
          if (rideRequests[rideId] && rideRequests[rideId].driverRequests) {
            rideRequests[rideId].driverRequests.forEach(otherDriverId => {
              if (otherDriverId !== driverId && drivers[otherDriverId]) {
                // Update other driver requests to rejected
                const otherRequestKey = `${rideId}_${otherDriverId}`;
                if (driverRequests[otherRequestKey]) {
                  driverRequests[otherRequestKey].status = 'rejected';
                }
                
                // Notify other drivers
                drivers[otherDriverId].ws.send(
                  JSON.stringify({
                    type: 'rejectedByUser',
                    rideId,
                    userId
                  })
                );
              }
            });
          }
          
          console.log(`User ${userId} accepted driver ${driverId} for ride ${rideId}`);
        }
      }
      
      // Handle user rejecting a driver request
      if (data.type === 'rejectDriver' && data.role === 'user') {
        const userId = data.userId;
        const rideId = data.rideId;
        const driverId = data.driverId;
        
        const requestKey = `${rideId}_${driverId}`;
        
        if (driverRequests[requestKey] && driverRequests[requestKey].status === 'pending') {
          // Update driver request status
          driverRequests[requestKey].status = 'rejected';
          driverRequests[requestKey].rejectedAt = new Date();
          
          // Notify the rejected driver
          if (drivers[driverId]) {
            drivers[driverId].ws.send(
              JSON.stringify({
                type: 'rejectedByUser',
                rideId,
                userId
              })
            );
          }
          
          console.log(`User ${userId} rejected driver ${driverId} for ride ${rideId}`);
        }
      }
      
      // Handle ride cancellation
      if (data.type === 'cancelRide') {
        const rideId = data.rideId;
        
        if (rideRequests[rideId]) {
          const userId = rideRequests[rideId].userId;
          const driverId = rideRequests[rideId].driverId;
          
          // Update ride status
          rideRequests[rideId].status = 'cancelled';
          rideRequests[rideId].cancelledAt = new Date();
          
          // Notify user and driver
          if (data.role === 'user' && driverId && drivers[driverId]) {
            drivers[driverId].ws.send(
              JSON.stringify({
                type: 'rideCancelled',
                rideId,
                cancelledBy: 'user'
              })
            );
          } else if (data.role === 'driver' && users[userId]) {
            users[userId].ws.send(
              JSON.stringify({
                type: 'rideCancelled',
                rideId,
                cancelledBy: 'driver'
              })
            );
          }
          
          console.log(`Ride ${rideId} cancelled by ${data.role}`);
        }
      }
      
      // Handle ride start
      if (data.type === 'startRide' && data.role === 'driver') {
        const driverId = data.driverId;
        const rideId = data.rideId;
        const userId = data.userId;
        
        if (rideRequests[rideId] && rideRequests[rideId].status === 'accepted' && rideRequests[rideId].driverId === driverId) {
          // Update ride status
          rideRequests[rideId].status = 'in_progress';
          rideRequests[rideId].startedAt = new Date();
          
          // Notify user
          if (users[userId]) {
            users[userId].ws.send(
              JSON.stringify({
                type: 'rideStarted',
                rideId
              })
            );
          }
          
          console.log(`Ride ${rideId} started by driver ${driverId}`);
        }
      }
      
      // Handle ride completion
      if (data.type === 'completeRide' && data.role === 'driver') {
        const driverId = data.driverId;
        const rideId = data.rideId;
        const userId = data.userId;
        
        if (rideRequests[rideId] && 
            (rideRequests[rideId].status === 'accepted' || rideRequests[rideId].status === 'in_progress') && 
            rideRequests[rideId].driverId === driverId) {
          
          // Update ride status
          rideRequests[rideId].status = 'completed';
          rideRequests[rideId].completedAt = new Date();
          
          // Notify user
          if (users[userId]) {
            users[userId].ws.send(
              JSON.stringify({
                type: 'rideCompleted',
                rideId
              })
            );
          }
          
          console.log(`Ride ${rideId} completed by driver ${driverId}`);
        }
      }
      
      // Handle driver rating
      if (data.type === 'rateDriver' && data.role === 'user') {
        const userId = data.userId;
        const rideId = data.rideId;
        const driverId = data.driverId;
        const rating = data.data.rating;
        const comment = data.data.comment;
        
        if (rideRequests[rideId] && rideRequests[rideId].status === 'completed' && rideRequests[rideId].driverId === driverId) {
          // Store rating information
          rideRequests[rideId].rating = {
            value: rating,
            comment,
            createdAt: new Date()
          };
          
          // Notify driver about rating
          if (drivers[driverId]) {
            drivers[driverId].ws.send(
              JSON.stringify({
                type: 'rated',
                rideId,
                userId,
                rating,
                comment
              })
            );
          }
          
          console.log(`Driver ${driverId} rated ${rating} by user ${userId} for ride ${rideId}`);
        }
      }
      
    } catch (error) {
      console.log('Failed to parse WebSocket message:', error);
    }
  });
  
  ws.on('close', () => {
    connectionCount--;
    console.log(`Client disconnected (remaining: ${connectionCount})`);
    
    // Remove disconnected drivers and users
    Object.keys(drivers).forEach(driverId => {
      if (drivers[driverId].ws === ws) {
        console.log(`Driver ${driverId} disconnected`);
        delete drivers[driverId];
      }
    });
    
    Object.keys(users).forEach(userId => {
      if (users[userId].ws === ws) {
        console.log(`User ${userId} disconnected`);
        delete users[userId];
      }
    });
    
    logConnections();
  });
});

// Function to find nearby available drivers
const findNearbyDrivers = (userLat, userLon, maxDistance = 5000) => {
  console.log(`Finding drivers near lat: ${userLat}, lon: ${userLon}`);
  
  // Validate coordinates
  if (userLat === undefined || userLon === undefined || 
      userLat === null || userLon === null ||
      isNaN(userLat) || isNaN(userLon)) {
    console.error('Invalid user coordinates:', { userLat, userLon });
    return [];
  }
  
  // Convert to numbers if they're strings
  const userLatNum = typeof userLat === 'string' ? parseFloat(userLat) : userLat;
  const userLonNum = typeof userLon === 'string' ? parseFloat(userLon) : userLon;
  
  if (isNaN(userLatNum) || isNaN(userLonNum)) {
    console.error('Invalid user coordinates after conversion:', { userLatNum, userLonNum });
    return [];
  }
  
  // Filter available drivers with valid coordinates
  const availableDrivers = Object.values(drivers).filter(driver => {
    if (!driver.isAvailable) {
      return false;
    }
    
    // Check driver coordinates
    if (driver.latitude === undefined || driver.longitude === undefined ||
        driver.latitude === null || driver.longitude === null ||
        isNaN(driver.latitude) || isNaN(driver.longitude)) {
      console.warn(`Driver ${driver.id} has invalid coordinates:`, 
        { lat: driver.latitude, lon: driver.longitude });
      return false;
    }
    
    return true;
  });
  
  console.log(`Total available drivers: ${availableDrivers.length}`);
  if (availableDrivers.length > 0) {
    console.log('Available drivers:', availableDrivers.map(d => ({
      id: d.id,
      lat: d.latitude,
      lon: d.longitude,
      available: d.isAvailable
    })));
  } else {
    console.log('No available drivers found');
  }
  
  if (availableDrivers.length === 0) {
    return [];
  }
  
  // Calculate distances and sort by closest
  const driversWithDistance = availableDrivers.map(driver => {
    try {
      // Convert coordinates to numbers if they're strings
      const driverLatNum = typeof driver.latitude === 'string' ? parseFloat(driver.latitude) : driver.latitude;
      const driverLonNum = typeof driver.longitude === 'string' ? parseFloat(driver.longitude) : driver.longitude;
      
      // Calculate distance using geolib
      const distance = geolib.getDistance(
        { latitude: userLatNum, longitude: userLonNum },
        { latitude: driverLatNum, longitude: driverLonNum }
      );
      
      return {
        ...driver,
        distance
      };
    } catch (error) {
      console.error(`Error calculating distance for driver ${driver.id}:`, error);
      return {
        ...driver,
        distance: Infinity
      };
    }
  });
  
  // Filter by max distance and sort by closest
  const filteredDrivers = driversWithDistance
    .filter(driver => driver.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance);
  
  console.log(`Found ${filteredDrivers.length} drivers within ${maxDistance/1000}km radius`);
  return filteredDrivers;
};

// Function to calculate estimated time of arrival in minutes
const calculateETA = (driverLat, driverLon, userLat, userLon, avgSpeed = 30) => {
  console.log('ETA calculation inputs:', { driverLat, driverLon, userLat, userLon });
  
  // Validate coordinates
  if (driverLat === undefined || driverLon === undefined || 
      userLat === undefined || userLon === undefined ||
      driverLat === null || driverLon === null || 
      userLat === null || userLon === null ||
      isNaN(driverLat) || isNaN(driverLon) || 
      isNaN(userLat) || isNaN(userLon)) {
    console.error('Invalid coordinates for ETA calculation:', { driverLat, driverLon, userLat, userLon });
    return 5; // Return a default value of 5 minutes
  }

  try {
    // Convert to numbers if they're strings
    const driverLatNum = typeof driverLat === 'string' ? parseFloat(driverLat) : driverLat;
    const driverLonNum = typeof driverLon === 'string' ? parseFloat(driverLon) : driverLon;
    const userLatNum = typeof userLat === 'string' ? parseFloat(userLat) : userLat;
    const userLonNum = typeof userLon === 'string' ? parseFloat(userLon) : userLon;
    
    // Validate converted values
    if (isNaN(driverLatNum) || isNaN(driverLonNum) || 
        isNaN(userLatNum) || isNaN(userLonNum)) {
      console.error('Invalid coordinates after conversion:', { 
        driverLatNum, driverLonNum, userLatNum, userLonNum 
      });
      return 5; // Return a default value of 5 minutes
    }
    
    // Calculate distance in meters
    const distance = geolib.getDistance(
      { latitude: driverLatNum, longitude: driverLonNum },
      { latitude: userLatNum, longitude: userLonNum }
    );
    
    // Convert distance to kilometers
    const distanceInKm = distance / 1000;
    
    // Calculate time in hours (distance / speed)
    const timeInHours = distanceInKm / avgSpeed;
    
    // Convert to minutes
    const timeInMinutes = Math.ceil(timeInHours * 60);
    
    // Return minimum 1 minute or calculated time
    const eta = Math.max(1, timeInMinutes);
    console.log(`ETA calculated: ${eta} minutes (distance: ${distanceInKm.toFixed(2)} km)`);
    return eta;
  } catch (error) {
    console.error('Error calculating ETA:', error);
    return 5; // Return a default value of 5 minutes
  }
};

console.log(`WebSocket server running on port ${WS_PORT}`);

// Start HTTP server for health checks
app.get('/', (req, res) => {
  res.send('Socket server is running');
});

app.listen(PORT, () => {
  console.log(`HTTP server running on port ${PORT}`);
}); 