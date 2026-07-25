import { Link } from 'react-router-dom';
import { uploadsUrl } from '../api';
import { User, Car, CreditCard, Clock, ShieldAlert, UserCheck } from 'lucide-react';
import { format } from 'date-fns';

export default function EventCard({ event }) {
  const { analysis } = event;
  const cameraName = event.cameraId?.name || 'Unknown';
  const date = format(new Date(event.capturedAt), 'dd/MM/yyyy HH:mm:ss');

  return (
    <Link to={`/events/${event._id}`} className="event-card">
      <img
        src={uploadsUrl(event.thumbnailPath || event.imagePath)}
        alt="capture"
        className="event-card-img"
      />
      <div className="event-card-body">
        <div className="event-card-camera">{cameraName}</div>
        <div className="event-card-time">
          <Clock size={14} /> {date}
        </div>
        <div className="event-card-tags">
          {/* Identity first — it is the most important thing about the event. */}
          {analysis?.faces?.some((f) => f.isStranger) && (
            <span className="tag tag-alert">
              <ShieldAlert size={12} /> Người lạ
            </span>
          )}
          {analysis?.faces?.some((f) => f.name) && (
            <span className="tag tag-ok">
              <UserCheck size={12} /> {analysis.faces.filter((f) => f.name).map((f) => f.name).join(', ')}
            </span>
          )}
          {analysis?.persons?.length > 0 && (
            <span className="tag tag-person"><User size={12} /> {analysis.persons.length}</span>
          )}
          {analysis?.vehicles?.length > 0 && (
            <span className="tag tag-vehicle"><Car size={12} /> {analysis.vehicles.length}</span>
          )}
          {analysis?.licensePlates?.length > 0 && (
            <span className="tag tag-plate"><CreditCard size={12} /> {analysis.licensePlates.map((p) => p.plateNumber).join(', ')}</span>
          )}
        </div>
      </div>
    </Link>
  );
}
